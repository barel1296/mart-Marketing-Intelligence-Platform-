# Metrics

Every number on the dashboard comes from a single governed registry
(`packages/metrics/src/registry.ts`). A metric that is not in the registry cannot
be displayed, and a metric in the registry carries its formula, its sources, its
grain and its availability rules with it. The tile shows all of that: the value,
where it came from, what date grain it is expressed in, and how fresh it is.

## The registry

| Key                            | Formula                                                                    | Grain            | Sources                     |
| ------------------------------ | -------------------------------------------------------------------------- | ---------------- | --------------------------- |
| `spend`                        | `SUM(spend)`                                                               | report date      | marketing network           |
| `impressions`                  | `SUM(impressions)`                                                         | report date      | marketing network           |
| `clicks`                       | `SUM(clicks)`                                                              | report date      | marketing network           |
| `link_clicks`                  | `SUM(link_clicks)`                                                         | report date      | marketing network           |
| `ctr`                          | `SUM(clicks) / SUM(impressions)`                                           | report date      | marketing network           |
| `cpm`                          | `SUM(spend) / SUM(impressions) * 1000`                                     | report date      | marketing network           |
| `cpc`                          | `SUM(spend) / SUM(clicks)`                                                 | report date      | marketing network           |
| `attributed_installs`          | `SUM(attributed_installs)` — organic included                              | **install date** | MMP                         |
| `mapped_paid_installs`         | `SUM(attributed_installs)` on mapped campaigns, organic excluded           | **install date** | MMP + reconciliation        |
| `organic_installs`             | `SUM(attributed_installs) WHERE media_source = organic`                    | **install date** | MMP                         |
| `attributed_revenue`           | `SUM(revenue) WHERE grain = event_date` — organic included                 | **event date**   | MMP                         |
| `mapped_attributed_revenue`    | `SUM(revenue)` on mapped campaigns, organic excluded                       | **event date**   | MMP + reconciliation        |
| `mapped_cpi`                   | `SUM(mapped spend)[report_date] / SUM(mapped installs)[install_date]`      | **mixed**        | both                        |
| `blended_cpi`                  | `SUM(spend)[report_date] / SUM(all attributed installs)[install_date]`     | **mixed**        | both                        |
| `mapping_coverage`             | `(matched_exact + matched_confident + manually_verified) / total_mappings` | n/a              | reconciliation              |
| `operational_mapping_coverage` | `(authoritative + high-confidence name matches) / total_mappings`          | n/a              | reconciliation              |
| `cohort_roas`                  | `cumulative_cohort_revenue / cohort_allocated_spend`                       | cohort date      | **unavailable in Phase 0A** |

## Four rules

### 1. Ratios are computed from sums, never averaged

`ctr` over a 30-day range is `SUM(clicks) / SUM(impressions)` over the whole
range. It is not the mean of thirty daily CTRs. Averaging ratios weights a day
with 100 impressions the same as a day with 10 million, which is simply a
different (and wrong) statistic. The same applies to CPM, CPC and both CPI
figures, and to every row of the campaign table.

### 1a. A ratio's two sides must describe the same population

`mapped_cpi` divides spend on mapped campaigns by installs attributed to those
same campaigns. `blended_cpi` divides _all_ spend by _all_ attributed installs —
organic and unmapped included — and is named for what it is. The difference is
not cosmetic: on a real account with 539 attributed installs of which 79 were
organic, the two figures were $0.30 and $0.26. The second is a fine blended
number and a badly wrong CPI, because the denominator contains installs the
numerator did not buy.

MART therefore never ships a metric called simply "CPI". Every tile says which
population it describes, and `blended_cpi` renders as `partial` with the organic
and unmapped counts stated on it whenever they are non-zero.

### 2. A ratio with a tiny denominator is withheld

Each ratio declares a minimum denominator. Below it the metric is reported as
`partial` with the reason, rather than showing a CPI of $4,000 computed from one
install. A number that is technically correct but practically meaningless is
still a bad number to put on a dashboard.

### 3. Grain is carried, displayed, and never silently mixed

Every metric declares its grain, and every tile shows it as a chip. Where a
metric genuinely spans grains — `reported_cpi` divides report-date spend by
install-date installs — the tile is labelled **mixed: report date / install
date** rather than pretending the two agree.

This is not pedantry. Report-date spend and install-date installs do not describe
the same population of users on the same day. Over a long, stable window the
ratio is a useful directional number; over a short window, or right after a
budget change, it is not. Labelling it is the difference between a metric an
analyst can reason about and one that quietly misleads.

The trend charts follow the same rule: delivery, installs and revenue are three
separate small multiples with their own grain chip, never two series on one pair
of axes with two y-scales.

### 4. Unavailable is a value, and it comes with a reason

Availability is one of `available`, `partial`, `stale`, `unavailable`:

- **available** — computed from fresh data.
- **partial** — computed, but from an incomplete window, a denominator below the
  minimum, or a source that reported for only part of the range.
- **stale** — computed from data older than the stream's expected freshness. The
  tile shows the latest data date.
- **unavailable** — not computed. The tile shows _why_, in place of a number.

A tile never shows `0` when it means "no data". Zero spend and no spend data are
different claims about the world, and the dashboard distinguishes them.

## Reported CPI vs Cohort CPI

Phase 0A shows **Reported CPI** and labels it as such.

**Reported CPI** = total spend reported on days _d…D_ divided by total installs
attributed to install days _d…D_. Both figures are real, both come from the
provider that owns them, and neither has been reshaped. What it does _not_ claim
is that these installs came from that spend.

**Cohort CPI** — the number a UA manager actually wants — is the spend allocated
to a specific install cohort divided by that cohort's installs. Computing it
requires cohort-level cost allocation: spend attributed to the cohort that a
day's installs belong to, which in turn needs cost data joined to attribution at
the cohort level (AppsFlyer's cost ETL, Tenjin's cohort reports, or a modelled
allocation). Phase 0A does not import any of that.

So MART reports what it can defend and names it precisely, rather than computing
a plausible-looking CPI and letting the reader assume it is cohort-based. Cohort
CPI, cohort ROAS and retention curves are Phase 0B/0C work.

## Cohort ROAS is permanently unavailable in Phase 0A

`cohort_roas` is in the registry with a permanent `unavailableReason`:

> Cohort-matched spend is not available yet. MART will not divide report-date
> spend by event-date revenue and call the result ROAS.

It is listed rather than hidden on purpose. The tile is where a user looks for
ROAS; finding an explanation there is more useful than finding nothing, and far
more useful than finding a number that divides two incompatible grains. That
division would produce a figure that moves for reasons unrelated to return —
a spend spike on day 30 makes "ROAS" fall even if every cohort is performing
identically — and an incorrect ROAS tile is worse than no ROAS tile, because
someone will spend money on it.

## Two coverage numbers

Reconciliation reports coverage twice, and they are never averaged into one:

| Number                 | Counts                                                     | Used for                             |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Authoritative coverage | stable id + manually verified                              | whether MART will state identity     |
| Operational coverage   | authoritative + deterministic high-confidence name matches | whether MART will state a mapped CPI |

The gap between them is the point. On the account this was built against,
authoritative coverage is 0% — Tenjin campaign ids are Tenjin UUIDs and can
never equal Meta's — while operational coverage is 100%, because every Tenjin
campaign name carries the Meta campaign name verbatim in parentheses. A mapped
CPI is computable and correct; a claim that the two providers share an identity
is not, and MART makes neither claim on the other's evidence.

Organic is excluded from both denominators. Unpaid traffic belongs to no
campaign, so counting it as an unmapped gap would make a healthy account look
broken.

## Attribution figures in the campaign table

The campaign table joins delivery to attribution **only through an authoritative
mapping** (`matched_exact`, `matched_confident`, `manually_verified`). For a
campaign whose mapping is `matched_fallback`, `ambiguous` or `unmatched`, the
attribution columns show `—` with a note explaining why, not a plausible number
sourced from a name match.

This is the rule that makes the reconciliation screen worth having: coverage is
not cosmetic, it decides which numbers the dashboard is willing to state.

## Freshness

Each stream declares an expected freshness window. `data_freshness` records the
last attempt, the last success and the latest date the provider actually had data
for. A metric computed from a stream past its window is marked `stale` and the
tile shows the data date, so a dashboard left open overnight cannot quietly show
yesterday's numbers as today's.
