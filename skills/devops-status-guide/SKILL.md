---
name: devops-status-guide
description: Gates and identifier chains for the devops_* tools. Covers what a vendor status reading can and cannot establish, how far incident history reaches on each backend, where regions live, and how to check a DNS change against the zone's own nameservers and a certificate failure against CAA. Use before calling a vendor up, down, or incident-free on a date, when scoping an outage to a region, in pre-deploy sweeps and postmortems, and when diagnosing a domain's DNS or TLS.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

- Vendor health, incidents, and maintenance windows as each vendor publishes them on its own status page, plus TLS and DNS probes of any public domain. Keyless.
- No tool measures a vendor's service. A status page is the vendor's own account and often trails real impact, so a clean reading means the vendor has posted nothing, not that the user's path works. A clean `devops_check_certs` or `devops_check_dns` on a vendor endpoint shows that DNS and TLS work from the server's network, not that the API answers.
- Probes run from wherever the server runs. `devops_check_certs` refuses a host that resolves to a private, loopback, or metadata address, and `devops_check_dns` refuses such an address as a resolver, unless the server was started with `DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true`, so an internal host or resolver needs a local server started that way. `devops_check_dns` queries any name at public resolvers, including one whose records point at private addresses. A deployment that disables active probes has no probe tools, and `devops_suggest_action` names `dig` and `openssl` instead.

## Identifiers

| Input | Where it comes from |
|:--|:--|
| Vendor slug | `devops_list_vendors`, whose `query` matches slugs and display names. The status tools take a slug in any letter case but not a display name ("gcp" works, "Google Cloud" fails); of the tools that take a vendor, only `devops_suggest_action` accepts a display name. |
| Unlisted vendor | Its Atlassian Statuspage base URL, scheme included (`https://status.example.com`); a bare host is rejected. A row whose error is an HTTP 404 or unparseable JSON means the URL is not a Statuspage base URL, and no other backend is reachable by URL. |
| Backend | `api_type` in the `devops-status://vendors/{slug}` resource. Native adapters serve `aws`, `gcp`, `azure`, `azure-devops`, `gitlab` and `neon` (Status.io), `slack`, and `redis-cloud` (Firehydrant); every other slug is Statuspage. |
| Atlassian product | Jira, Confluence, Bitbucket, Trello, Opsgenie, and several other Atlassian products each have an entry; `devops_list_vendors` with query "atlassian" lists them. A product without one, such as Loom, takes its own Statuspage base URL (`https://loom.status.atlassian.com`). `atlassian` itself reads the umbrella page, which has no components and posts only cross-product incidents, so it never stands in for a product. |
| One incident | No tool fetches an incident by id. Find it again with `devops_get_incidents`, using `match` on title words and `since`/`until` around its start. |
| Next page | `nextOffset` for incidents. For a component list that continues past the page, pass the vendor's `next_component_offset`, from a `devops_status_check` or `devops_watch_stack` row, as `component_offset` to `devops_status_check` in detailed mode, with the same `component_filter`. |
| DNS resolver | IP literals only. To ask a zone's own nameservers, query `NS`, then `A` for each nameserver host, then pass those addresses as `resolvers`. |

## Gates

1. **Read the whole row before calling a vendor clear.** `indicator` is the vendor's overall rating as published. A page can read `none` with an open `major` incident, or `major` from degraded components with no incident open. `summary`, `health`, and the icon on each vendor's heading count each vendor by the worse of `indicator` and its worst open incident rated `minor` or worse, so quote those rather than `indicator` alone, and read `active_incidents` and `degraded_components` for what is wrong before reporting a vendor or a stack as clear. A row with `error` is unknown, never healthy.
2. **Tie impact to the user's components.** A degraded vendor matters only when a degraded component, or an incident's affected components, is one the user's path uses. Name those components (for a deploy on GitHub: Actions, Git Operations, Packages, Webhooks) and read them with `mode: "detailed"` and `component_filter`.
3. **Confirm reach before reporting absence.** A history proves nothing about dates older than its oldest record. Check History reach below before saying a vendor had no incident on a date. Where no archive is read, a `since` earlier than the oldest record the feed returned gets a `notice` naming the date the feed starts (`redis-cloud` gets none, its feed being its full history); `until` alone gets no such notice. A Statuspage page that publishes no archive says so in `notice` instead, with no date.
4. **Convert dates to UTC days.** `since` and `until` are UTC dates compared with each record's start (`scheduled_for`, else the earlier of `started_at` and `created_at`), and vendor timestamps carry their own offsets (Slack and Twilio publish local ones such as `-07:00`). For a day in the user's zone, query a day either side and filter on the timestamps.
5. **Read severity from the text where the feed has none.** `azure` and `azure-devops` rate every incident `minor`. The `azure-devops` overall description can read "Service maintenance is in effect" while its open item is a fault, so read the item. `gcp` maps Google's low, medium, and high to `minor`, `major`, and `critical`.
6. **Separate upcoming maintenance from history.** `filter: "scheduled"` returns completed windows too on Statuspage (which can keep years of them) and `redis-cloud`. Check each window's `status` and `scheduled_for` against the deploy time, or read `scheduled_maintenances` from a detailed status check, which lists only current and upcoming windows. `aws`, `gcp`, `azure`, `azure-devops`, and `slack` publish no windows, so their silence says nothing about planned work.
7. **Don't poll faster than the cache.** Status reads are cached across all callers, 60 s unless the deployment sets another TTL; a sooner re-check returns the same snapshot with `cached: true`, and `checked_at` is the time of the check, not of the fetch.
8. **A probe row rejected before any query is no answer.** A `devops_check_dns` row whose `error` comes with empty `resolver_results` was never sent to a resolver, so it says nothing about what the name resolves to; with resolver results, `error` is a real outcome, such as NXDOMAIN at every resolver.
9. **Treat playbooks as guidance.** `devops_suggest_action` returns fixed text chosen by the vendor's category and keywords in the context passed; it holds no facts about this incident. Its pre-filled calls from the status tools never set `your_domain`; add it to get the DNS and certificate follow-ups.

### History reach

| Backend | Incidents returned | Archive read by `since` | Maintenance windows |
|:--|:--|:--|:--|
| Statuspage | the newest 50, under a week on a busy page | quarterly, up to 24 months back, title and final update only; some pages publish none, and `sendgrid` reads none | yes, completed ones included |
| `slack` | a recent window | none | none |
| `gcp`, `azure-devops` | a rolling recent window, resolved kept | none | none |
| `aws` | open events, and resolved ones for some hours | none | none |
| `azure` | open items only, never resolved | none | none |
| `gitlab`, `neon` | current incidents only | none | upcoming and in progress only |
| `redis-cloud` | full history | none | yes, completed included |

Where no archive is read, the oldest record returned is the reach, and the vendor's status page holds the rest.

## Workflows

**Deploy gate.** `devops_watch_stack` or `devops_status_check` over the user's vendors, gates 1 and 2 on every row, a detailed check with `component_filter` on the components the deploy touches, `devops_get_incidents` with `filter: "active"` and `match` on one component at a time for the timeline, then gate 6 for windows inside the deploy time.

**Postmortem.** `devops_get_incidents` with `filter: "resolved"` (or `"all"` to include maintenance) and `since`/`until` padded per gate 4, then gate 3. Records with `source: "history"` carry one final update, no components, and a null `duration_minutes`: subtract `created_at` from `resolved_at` (minute precision), match them on title words, and open `shortlink` for the full timeline.

**Region scoping.** A region lives in a different field on each backend:

| Backend | Find a region with |
|:--|:--|
| `aws` | a detailed status check with `component_filter` on the code (`me-central-1`); components exist only for open events. Incident titles carry the region name, so `match` takes "UAE", not the code |
| `gcp` | `devops_get_incidents` with `match` on a location id or name (`us-central1`, `iowa`), which reads `affected_locations`; the status check carries no region |
| `azure` | `devops_get_incidents` with `match` on the region name, which sits beside the services in `affected_components` |
| `azure-devops` | `component_filter` on the geography name ("Europe", "Australia") |
| `neon` | `component_filter` on the region (`us-east-1`), filed as a leaf under each component |
| Statuspage | per vendor; `component_filter` also matches group names, which many pages use for regions (Cloudflare files points of presence under "Europe", "North America") |

**Narrowing.** `match` and `component_filter` read text differently. `match` (incidents) keeps a record only when every word appears, in any order, each matching all or part of a word, and splits on hyphens and other punctuation: `me-central-1` is three words, and a short word such as `1` or `us` also matches inside longer words and dates ("status", "2026-11-03"), so it narrows little. `component_filter` (status checks, detailed mode only) is one contiguous substring: `git op` finds Git Operations, and `git-operations` finds nothing.

**DNS change not visible.** Query the zone's own nameservers (Identifiers) beside a public resolver. New value at the nameservers and the old one at public resolvers: caches still hold the old record until its TTL runs out, and this tool reports no TTL, so read it from the DNS provider. Old value at the nameservers: the change was never published. A name queried before its record existed can stay cached as missing for up to the SOA's last field, in seconds. Nameservers and resolvers can answer differently by design (load balancing, more than one DNS provider), so `value_variation` alone is no fault.

**Certificate will not issue or renew.** `devops_check_certs` for what is served now, then `devops_check_dns` with `record_types: ["CAA"]` on the name and every parent domain in one call: the closest name with CAA records decides which authorities may issue. For a DNS-01 challenge, read `TXT` at `_acme-challenge.<name>` across resolvers; a CNAME there is followed.
