# Decisions

Phase 3 turns trusted MART metrics into deterministic decision signals. This
document is the contract: what a signal is, what it is drawn from, which gates
stand between the data and a `scale` or `reduce`, and what MART will never do
with one.

## What a signal is

A signal is a reading of stored figures against an operator-stated target. It
is one of five words:

| Signal              | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `scale`             | The mature return is above the target band and every hard rule holds.          |
| `reduce`            | The full mature return is below the target band and every hard rule holds.     |
| `hold`              | At target, no target, a partial return below target, or a contradicting trend. |
| `investigate`       | Something on the data side needs a person before the figures can be read.      |
| `insufficient_data` | Not enough trusted, mature, mapped, fresh data to say anything at all.         |

A signal is never an action. The payload carries `automation: 'none'`, every
recommendation's `actions` is typed as an empty array, no API endpoint changes a
campaign, and no table stores a campaign change. MART recommends; a person
acts on the marketing network.

Every signal has a category, so a tracking problem never wears the clothes of
a performance problem: `performance`, `data_quality`, `pacing`, `coverage`, or
`undetermined` when MART cannot tell and says so.

## The recommendation object

Every recommendation carries, for one scope (a marketing campaign, or the app's
mapped population):

- **signal, category, headline, reason** - the reading and why, in prose that
  quotes the figures.
- **window** - the requested window, the app's timezone, the mature days the
  reading was actually drawn from (`evaluated`), and the trend baseline.
- **population** - `cohort_aligned_paid_attribution` over
  `cohort_aligned_marketing`: paid cohorts on operationally mapped campaigns,
  over the spend that bought them on their install day. The same populations
  Phase 2 defined.
- **evidence** - every figure the reading rests on, each with its own
  availability, blocker, numerator, denominator, window, population and grain:
  spend (`report_date`), mapped paid installs (`install_date`), mapped CPI, the
  cohort return (`cohort_date`) with its trend, and the count of anomalous days.
- **quality** - freshness per stream, unresolved sync errors, findings in the
  window, maturity (mature / too young / not re-read), mapping state, currencies
  on both sides, and the anomalies that bear on the scope.
- **confidence** - the Phase 1 decomposed score with two more components:
  maturity (mature days over delivered days) and mapping strength. Confidence
  qualifies a reading; it never changes a figure or makes a withheld one valid.
- **blockers** - why `scale` or `reduce` could not be issued. Every metric
  blocker applies unchanged, plus `no_target`, `data_quality_finding`,
  `anomalous_data`, `partial_return` and `trend_contradicts`.
- **policy** - the targets and thresholds the reading used.
- **lineage** - metric keys, fact families, providers, a hash over the evidence
  and signal, the rule version, and when it was computed.

The same rows always produce the same recommendation, byte for byte apart from
`computedAt`. The id is a hash of rule version, app, scope and window.

## Targets

Targets are business inputs MART cannot derive: a break-even D7 ROAS depends on
margins and payback appetite that are not in the data. They are stored per app
in `decision_policies` exactly as the operator typed them - a D7 cohort ROAS
target, a D1 target, a CPI ceiling with its currency - and changed only
through `PUT /organizations/:org/apps/:app/decision-policy` (permission
`app:update`, audited).

Without a target MART still reports every figure, trend, pacing state and
anomaly. It never says `scale` or `reduce`, because it has nothing defensible
to say them against; the recommendation is `hold` with the blocker `no_target`.

The floors and bands the reading needs are constants in one place
(`DECISION_THRESHOLDS`), reviewed rather than configured:

| Threshold             | Value   | Protects against                                    |
| --------------------- | ------- | --------------------------------------------------- |
| minimum mature days   | 3       | one big day read as a trend                         |
| minimum spend         | 50      | a ratio on pocket change                            |
| minimum installs      | 25      | one more install moving the figure                  |
| tolerance band        | ±15%    | acting on 0.52 against a target of 0.50             |
| trend halves          | 7 + 7   | a window average hiding where the campaign is now   |
| material trend change | 20%     | noise read as momentum                              |
| anomaly baseline      | 14 d    | a day judged against too little history             |
| pacing band           | 50–125% | networks that legitimately overshoot a daily budget |

## The gates, in order

A figure is read against a target only after every gate before it holds. The
first gate that fails decides the signal, and names itself in the category and
the blocker.

1. **A provider is bound** for both roles, else `insufficient_data` /
   `missing_provider`.
2. **The campaign is operationally mapped** (Phase 1's rule). Unmapped ->
   `insufficient_data` / `coverage` / `insufficient_coverage`. Ambiguous ->
   `investigate` / `coverage` / `ambiguous_mapping`. At app scope, mapped spend
   below 80% of window spend withholds the reading and ambiguous spend above
   10% asks for an investigation.
3. **The streams are current.** A stream in error, or any unresolved sync
   error, -> `investigate` / `data_quality`. A stale or unknown stream, or no
   attribution horizon, -> `insufficient_data` / `provider_stale`. `delayed`
   is allowed and lowers confidence.
4. **One currency** across spend and cohort revenue, else `investigate` /
   `mixed_currency`. MART never converts.
5. **No error-severity data-quality finding** in the window, else
   `investigate` / `data_quality_finding`. Findings about the account's
   reconciliation (unmapped spend or installs) bear on the app scope, whose
   coverage gates already read them; a mapped campaign's own rows are not
   misaligned by its neighbours' gaps.
6. **No data-side anomaly** in the window (`data_gap` or `attribution`), else
   `investigate` / `data_quality` / `anomalous_data`. An `undetermined` or
   `monetization` anomaly -> `investigate` / `undetermined`. A `delivery`
   anomaly is a fact about delivery and blocks nothing.
7. **A target exists and the report supplies the return it needs.** D7 first,
   then D1, each only where the provider reports cohort revenue at that age
   (Phase 2's probed capabilities); the full return (`total`) preferred, a
   single component otherwise. No usable return but a CPI ceiling -> the CPI
   rule. Neither -> `hold` / `no_target`, or `hold` / `unsupported_metric` with
   the provider change named.
8. **Enough mature volume.** No mature delivered day -> `insufficient_data` /
   `immature_cohort`, or `provider_stale` when the days are old enough but no
   revenue sync has read them since they matured (a day nobody re-read is not a
   day that earned nothing). Below the floors -> `insufficient_data` /
   `missing_denominator`.
9. **The reading.** Cohort return over mature delivered days (cohort revenue at
   the age, over the spend that bought those cohorts on their install day,
   summed, never averaged) against the target band. Above -> `scale`, below ->
   `reduce`, inside -> `hold`. A component-only return above target proves the
   full return is above target, so it may `scale`; below target it proves
   nothing and is `hold` / `partial_return`. When the newest seven mature days
   move the other way by a material amount, the window average is not where the
   campaign is now: `hold` / `trend_contradicts`.

The CPI rule reads mapped CPI over delivered days the attribution horizon has
passed, against the ceiling with the same band; the policy currency must equal
the spend currency.

## Anomalies

Each day in the window is judged against the 14 days before it, for spend,
installs and event-date revenue, per campaign and for the app as a whole. A day
is anomalous only when it is 3.5 MAD-scaled deviations from the median of those
days (or simply differs, when every baseline day is identical), differs by at
least 30% of the median, and differs by at least 20 in absolute terms. Fewer
than seven baseline days and no call is made.

Classification comes from the data around the day, never from the size of the
move:

| Class          | When                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `delivery`     | spend moved; or installs moved the same way as spend on the same day                                                 |
| `data_gap`     | an unresolved sync error covers the day, or no completed install sync read it                                        |
| `attribution`  | installs moved while spend held, with a data-quality finding on the day or an attribution stream that is not current |
| `monetization` | revenue moved while installs and spend held                                                                          |
| `undetermined` | installs moved while spend held and nothing on the data side explains it                                             |

`undetermined` is a deliberate answer: MART does not know whether a creative
fatigued or an SDK broke, and it will not pick the flattering one.

A finding counts as a signal for a day only when it is about that day's rows.
Findings that describe how rows are labelled (organic traffic has no campaign
id every day) or the account's reconciliation are not evidence that a day was
read wrongly.

## Pacing

Average spend over the days a campaign delivered, against the daily budget MART
last observed on the campaign (or the sum of its ad sets' daily budgets when the
budget sits there): under 50% is `under`, over 125% is `over`, otherwise `on`.
No budget, no delivery, or two currencies -> `unknown`, with the reason. Pacing
is reported beside the signal and is never a signal itself.

## Trends

The newest seven mature delivered days against the seven before them, both
halves required to clear the same floors as the signal. Stable under a 20%
relative change. Reported as evidence on the return figure and used only to
withhold a `scale` or `reduce` the newest days contradict.

## API and UI

- `GET /organizations/:org/apps/:app/decisions?from=&to=` (permission
  `metrics:read`) - the recommendation set for a window (default: the last 28
  days in the app's calendar, because a D7 reading needs at least eight-day-old
  cohorts and three mature days).
- `GET` / `PUT /organizations/:org/apps/:app/decision-policy` - the targets.

The Decision Center page (`/apps/:appId/decisions`) shows the targets form, the
app-level reading, every campaign's reading with its evidence table, quality,
confidence decomposition and lineage, the pacing table and the anomaly table.
Nothing on it changes a campaign.

## Audit

`pnpm phase3-audit <organization_id> <from> <to> [app_id]` recomputes every
figure a signal rests on with independent SQL, recomputes the signal from its
own band arithmetic, checks every reported gate against stored rows, finds
anomalies with its own median/MAD and re-derives their classes, recomputes
pacing, checks the app-level return against Phase 2's cohort ROAS, and proves
the hard rules with controlled changes inside transactions that are always
rolled back and verified rolled back: no target, a target below and above any
return, a stale feed, a second currency, an ambiguous mapping, an immature
window, revenue read-windows removed, and a synthetic campaign whose installs
collapse with spend steady - once with nothing on the data side (an
`undetermined` movement, never performance) and once under an unresolved sync
error (a `data_gap`).

## What Phase 3 does not do

No forecasting, no predicted LTV or ROAS, no budget or bid arithmetic, no
write-back to a provider, no scheduled or automatic execution of anything. A
signal MART cannot support safely from the stored rows is returned as
`insufficient_data` or `investigate` with its blocker, never invented.
