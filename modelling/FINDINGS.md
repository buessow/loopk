# Glucose prediction: findings

Status as of 2026-10-20. Offline study on loopk's data (one person, AAPS
closed loop, 2019-04 – 2026-10). Reproduce with `uv run python train.py`
(60-minute model comparison), `uv run python scenarios.py` (4-hour model,
dosing, eat-now and high scenarios), `uv run python whatif.py` (forecasts
under an insulin plan), `uv run python benchmark.py` (the standard
benchmark of every model), `uv run python synthetic.py` (synthetic insulin
data), `uv run python corrections.py` (the measured effect of a correction),
`uv run python periods.py` (bias by test period) and
`uv run python architectures.py` (network shapes); full tables land in
`results/`. Figures
are from the latest `scenarios.py` run unless noted; the model's figures vary
by a few tenths of a mg/dL, and its warning operating points by a few
percentage points, between training runs.

## Summary

- A small neural network (MLP, two layers of 128 and 64 units) predicts
  glucose about **27–35% more accurately than "glucose stays the same" and
  than AAPS's IOB curve**, at every horizon from 30 minutes to 4 hours.
  Mean absolute error is 17 mg/dL at 30 minutes, 27 at 1 hour, and levels off
  around 32 from 2 hours on.
- The 2024 notebook's figures (90% / 77% Clarke zone A at 30 / 60 min) were
  inflated, mainly because the model was given insulin and carbs from the hour
  it predicted. Honest figures are 79% / 62%.
- Predicting lows is the weak spot. A model tuned for average error predicts
  too high before lows, because lows are rare and in the training history
  they usually get rescued by AAPS or by eating.
- Scored per use, the model's dedicated outputs (event probabilities and low
  percentiles) work much better than its expected-glucose output:
  - **Dosing:** at the same share of below-target events caught, insulin
    delivered before a real low (< 70) is about half as common as with AAPS's
    IOB curve, with less unnecessary suspension. Against AAPS's actual rule,
    the model forecasts the 4-hour minimum about 2.5 times more accurately
    than `minGuardBG` (MAE 16 vs 44 mg/dL). As a suspend decision, though,
    the gain is modest, and offline scoring cannot settle it, because AAPS's
    own reactions are in the outcomes.
  - **What-if forecasts:** a model that learns the effect of planned insulin
    from closed-loop data gets it backwards: it predicts that suspending
    lowers glucose, because AAPS suspends when glucose falls. The insulin
    effect has to stay physics (ISF × insulin acted), as in oref. By that
    physics, a suspension changes glucose by only about 4 mg/dL within an
    hour and 18 within 2 hours.
  - **Eat-now warning:** about 88% of lows announced, with about 13 false
    alarms a week, versus 69% and 18 for the AAPS IOB curve. But only about
    63% of lows are announced at least 15 minutes ahead, which is the main
    thing to improve.
- **Your actions:** whether you eat is predictable from the time of day
  when glucose is normal (AUC 0.83), but close to random when falling toward
  a low. Manual boluses follow clear rules (meals; corrections above 180,
  above 120 when rising, above 160 when falling slowly, and at night above
  120), which explain 95% of them. The amounts, and AAPS's own SMBs and temp
  basals, are hard to predict.
- **Standard benchmark** (all models on the same test slots, see "Standard
  benchmark"): at 30 minutes the networks' MAE is 17–18 mg/dL, AAPS's IOB
  curve 21 and "no change" 22. At 7 alarms a week, the networks catch about
  half of the lows (three out of four alarms correct), AAPS's curves at most
  two fifths.
- **Synthetic insulin data** fixes the "more insulin, higher glucose"
  pattern the closed loop teaches (see "Synthetic insulin data"): 2 more
  units now lower the forecast in 99.9% of test samples, by close to the
  measured 11.7 mg/dL per unit, at a cost of about 0.2 mg/dL of accuracy.
- **The server** now uses glucose, its level over the last days, insulin
  and carbs, trained with synthetic data: MAE 17.2 at 30 minutes, against
  17.7 for glucose alone.
- Highs (above 180) happen about 3 times a day, mostly after meals. No
  method predicts a rise before it starts. Once glucose is rising, high
  warnings work well, and while coming down from a high the model predicts
  the descent accurately (bias about −1 mg/dL at 1 hour), which matters for
  not over-correcting.

## Setup

- **Data:** sensor glucose, boluses (including SMBs), temp basals, profile
  switches and profiles, extended boluses, carbs, heart rate, and AAPS's
  predicted curves, read from Postgres (`glupred/load.py`).
- **Duplicate boluses:** from late 2019 to 2020, almost every SMB was also
  stored as a pump-synced "Correction Bolus" about a second later, and in
  2025 about 1,000 boluses came twice. A second record of the same dose
  within a minute is dropped (real SMBs are at least 3 minutes apart). This
  brings 2019–2020 insulin from about 58 to 40 U/day, in line with later
  years. Accuracy at 15 and 30 minutes barely changed (within 0.3 mg/dL);
  the 1–4 h model and the what-if physics have not been rerun yet.
- **SMBs** are marked as type SMB or `is_smb`, except from late 2023 to
  early 2025, when they came only as synced "Correction Bolus" records.
- **Grid:** everything is put on a 5-minute grid. Basal delivery is
  integrated per minute from the profile in effect and the temp basals.
  `rate` is the absolute rate also for percent temps, and a temp basal
  without a duration is a cancel. Extended boluses that a `FAKE_EXTENDED`
  temp basal emulates are counted once. Local time comes from the uploader's
  UTC offset (Europe/Zurich before 2020).
- **Inputs:** only data up to the prediction time:
  - 2 hours of glucose history
  - activity of the insulin and carbs already given, in the past and
    committed for the coming hours (exponential insulin curve with a 55/360
    min peak/duration; log-normal carb curve with its mode at 45 min)
  - insulin and carbs on board, and the profile basal rate
  - recent heart rate and minutes above 120 bpm in the last 6 and 24 hours
  - time of day
- **Split by time:** train 2019-05 – 2024-12; validation 2025-01 – 2025-06
  (early stopping and thresholds); test 2025-07 – 2026-10 (reported).
- **Unlogged rescue carbs:** carbs are logged for only 19–40% of lows
  around the drop itself (34–61% when counting until glucose is back above
  70, see "Usual actions"). When
  glucose falls below 70 after 30 minutes above it, and no carbs were logged
  in the previous 30 minutes, 15 g is assumed eaten. The rule uses only the
  past, so live predictions can apply it too.
- **"If nothing is eaten":** training ignores glucose targets that come after
  any new carbs (logged or assumed), so the glucose outputs predict what
  happens without eating.
- **Glucose level** (benchmark and server models): the mean glucose of the
  last 1, 3 and 7 days, which tracks slow changes in sensitivity and keeps
  the bias per half-year within about ±2.5 mg/dL.
- **Calibration:** a network trained on log(g[t+h] / g[t]) predicts the
  geometric mean, which lies below the mean. After training, a shift per
  horizon (log of the mean actual / predicted on validation data) is added
  to the output bias (`glupred/nn.py`). It brought the mean |bias| at 30
  minutes over rolling test periods from 2.7 to 0.6 mg/dL (with the level
  inputs).
- **Outputs:** expected glucose (trained on log(g[t+h] / g[t]), so errors
  count relative to the glucose level), its 10th, 25th, 75th and 90th
  percentiles, and probabilities of going below target within 1, 2, 3 and 4
  hours, below 70 within 30 minutes, above 180 within 30 minutes, and above
  250 within 60 minutes.

### Comparison methods

- **Persistence:** glucose stays at the latest reading.
- **Linear trend:** a straight line through the last 15 minutes, extended.
- **AAPS curves** (oref `predBGs`, recorded every 5 minutes; checked against
  `aaps-dev`'s `DetermineBasalSMB.kt`). Each starts at the current glucose,
  has up to 48 points (4 hours), and is clipped to 39–401 mg/dL.
  - **IOB:** insulin activity plus the current deviation (the glucose
    movement insulin doesn't explain), fading linearly to zero over 60
    minutes. It is not "insulin only".
  - **COB:** adds absorption of entered carbs.
  - **UAM:** projects the unexplained rise, decaying.
  - **ZT:** zero temp from now.
  - They are "what if" curves for dosing, not best guesses, and AAPS reacts
    to them, which changes the outcome they are scored against.
  - IOB, COB and UAM have trailing flat values trimmed, so continuing them
    flat is exact. ZT is trimmed once it rises above target, so it is only
    usable for short horizons.
  - "AAPS auto" (COB while carbs are on board, else UAM, else IOB) is a
    simplification. AAPS doses on blended minimums of these curves; see
    "Scenario A as AAPS decides it".
- **Ridge, MLP, gradient boosting:** trained on the same inputs. Ridge
  (essentially the 2024 model) is clearly worse. Gradient boosting matches the
  MLP but is harder to port, so the MLP is the one carried forward.

## Prediction accuracy (test period)

Errors in mg/dL. P90 is the error 90% of predictions stay under. MARD is the
average error as a percentage of the actual value.

| Method | MAE 30 min | P90 30 min | MAE 1 h | P90 1 h | MAE 2 h | MAE 4 h | Zone A 30 min / 1 h / 4 h |
|---|---|---|---|---|---|---|---|
| Persistence | 23.4 | 54 | 36.4 | 83 | 43.0 | 44.5 | 67% / 50% / 39% |
| Linear trend | 29.1 | 69 | 63.9 | 148 | 125.5 | 232 | 62% / 34% / 11% |
| AAPS IOB | 23.5 | 55 | 39.6 | 89 | 52.3 | 54.8 | 68% / 46% / 30% |
| **MLP** | **17.2** | **40** | **26.6** | **62** | **31.0** | **32.7** | **79% / 62% / 52%** |

- **Noisier recent data:** in 2025–26 glucose moves about 5.5 mg/dL per 5
  minutes, versus about 4 in 2020, so every method scores lower there.
- **The 2024 setup's leak:** giving ridge the insulin and carbs actually
  delivered during the predicted hour raises zone A at 30 minutes from 76% to
  84%. The live system cannot know those.
- **Overall accuracy against relative error:** training on the log target
  leaves overall accuracy unchanged, and lifts zone A for actual lows by about
  10 points. Weighting samples toward lows helps lows only by giving up
  accuracy on highs, so the main model is not weighted.

## Why Clarke zone A looks good while lows do not

84% of samples are in the 70–180 range, where zone A is about 82% (within
20%, i.e. ±24 mg/dL at 120). Lows are 2.4% of samples, so they barely move
the overall score. By actual glucose, 30 minutes ahead:

| Actual | Share | Bias of expected glucose | Zone A |
|---|---|---|---|
| < 54 | 0.3% | +34 | 20% |
| 54–70 | 2.1% | +25 | 27% |
| 70–180 | 84% | ±1 | 81% |
| 180–250 | 12% | −22 | 76% |
| > 250 | 1.6% | −49 | 59% |

The expected-glucose output pulls predictions toward normal in both
directions. Before lows it usually sees the drop but predicts around 80
instead of below 70. Before highs it predicts too low. That's why the
scenarios below use the percentile and probability outputs instead.

## Scenario A: dosing

AAPS-style: suspend insulin when glucose is predicted to go below the
target's lower end (5.5 mmol/L, 99 mg/dL) within the window. A missed event
means insulin is delivered that cannot be taken back. An unnecessary
suspension is cheap because delivery resumes. The test covers samples at or
above 99, with each threshold set on validation to catch 90% or 95% of events.

| Window | Method | Events caught | Suspended, % of time | Missed events that went < 70 |
|---|---|---|---|---|
| 1 h, target 95% | AAPS IOB | 91% | 77% | 10.2% |
| | MLP 10th percentile | 93% | 67% | 5.3% |
| | **MLP P(below target in 1 h)** | **93%** | **66%** | **4.7%** |
| 1 h, target 90% | AAPS IOB | 84% | 61% | 16.6% |
| | **MLP P(below target in 1 h)** | **88%** | **55%** | **9.0%** |
| 2 h, target 90% | AAPS IOB | 81% | 75% | 21.7% |
| | **MLP P(below target in 2 h)** | **89%** | **72%** | **8.4%** |
| 4 h, target 90% | AAPS IOB | 81% | 77% | 20.7% |
| | **MLP P(below target in 4 h)** | **89%** | **79%** | **7.6%** |

- **Missed events that went < 70** are the costly case: insulin delivered,
  then a real low. The model has about half as many as the AAPS IOB curve at
  every window.
- **AAPS IOB falls short of its target on the test period** (81–91% caught
  instead of 90/95%), so its threshold did not carry over from validation.
- **"Below 99 within 2–4 hours" is too common to discriminate well:** the
  suspend share approaches 80–90%, close to persistence. For longer windows a
  lower threshold (for example < 70 within 2–4 h), or a predicted eventual
  glucose as oref uses, is probably the more useful decision.
- **This is offline:** it measures whether a method flags what actually
  happened under AAPS's own dosing, not how outcomes change if the model
  drove the decisions.
- **This table compares predictors, not decisions.** The AAPS rows use its
  IOB curve with a threshold tuned like the model's. AAPS's real rule is
  scored in the next section.

### Scenario A as AAPS decides it

Checked against `DetermineBasalSMB.kt`, AAPS decides in two steps:

- **Low glucose suspend:** it sets a zero temp when glucose is, or is
  predicted to get, below a threshold of min_bg − ½ (min_bg − 40). That's
  about 70 mg/dL for a 99 target; the logs show 3.9–4.2 mmol/L. The
  prediction is `minGuardBG`, the minimum over a carb-weighted blend of the
  COB and UAM curves (or UAM, or IOB) across their whole length, up to
  4 hours. SMBs are off while this holds.
- **Below target:** when the eventual glucose (`eventualBG`) is below
  min_bg, it lowers the temp basal, often to zero.

Every loop logs these values in its reason text, so AAPS's actual decisions
can be scored. Rows labelled "AAPS as run" are what it did. The model's rows
use a threshold set on validation to match AAPS either in time on or in
events caught.

**Suspend.** Outcome: glucose falls below 70 within 4 hours (samples at or
above 70; about 22% of them have such a fall).

Each row is one way of deciding, scored on every 5-minute moment:

- **Suspended:** share of moments where it says "suspend now". This is the
  cost.
- **Events caught:** of the moments with a low coming within 4 hours, the
  share where it already suspends. Moments hours before a low count too, so
  this stays well below 100%.
- **Followed by a low:** of its suspensions, the share where glucose went
  below 70 within 4 hours.
- **Followed by a low, or carbs within 1 h:** the same, but a suspension also
  counts as justified when carbs (logged, or the assumed 15 g rescue) were
  eaten within the hour, since eating may be what kept glucose up.
- **Lows covered in time:** counted once per low (glucose crossing below 70):
  the share where suspension was on for at least 30 of the 60 minutes before.

"Always on" gives the base rates. The model's rows use a threshold set on
validation to match AAPS either in time suspended or in events caught.

| Method | Suspended | Events caught | Followed by a low | Followed by a low, or carbs within 1 h | Lows covered in time |
|---|---|---|---|---|---|
| Always on (base rate) | 100% | 100% | 22% | 33% | 99% |
| AAPS as run: `minGuardBG` < threshold | 31% | 46% | 32% | 45% | 81% |
| MLP P(below 70 within 4 h), same time suspended | 33% | 56% | 38% | 51% | 81% |
| MLP 10th percentile, same time suspended | 33% | 55% | 37% | 50% | 86% |
| MLP P(below 70 within 4 h), same events caught | 27% | 49% | 40% | 53% | 76% |
| MLP 10th percentile, same events caught | 27% | 49% | 39% | 53% | 80% |

- **Counting carbs, about half of the model's suspensions are justified,**
  against 45% of AAPS's. The other half were followed by neither a low nor
  food within the hour.
- **Carbs within 4 hours is not informative:** they follow 61% of all
  moments, AAPS's suspensions 67%, and the model's 72–78%
  (`results/scenarios.md`).

**Reduce insulin.** Outcome: the mean glucose 3–4 hours ahead is below 99.

| Method | On, % of time | Events caught | Followed by the event | Followed by the event, or carbs within 1 h |
|---|---|---|---|---|
| Always on (base rate) | 100% | 100% | 16% | 32% |
| AAPS as run: `eventualBG` < 99 | 35% | 43% | 19% | 43% |
| MLP P(3–4 h mean below target), same events caught | 33% | 49% | 23% | 36% |
| MLP 25th percentile, same events caught | 34% | 49% | 22% | 37% |
| MLP P(3–4 h mean below target), same time on* | 42% | 58% | 21% | 36% |

\* Matched on validation; AAPS was on less often in the test period.

- **With carbs counted, AAPS's insulin reductions are justified more often
  than the model's** (43% vs 36–37%). A likely reason is a bolus given before
  eating: until the carbs are entered, AAPS sees insulin without food,
  predicts a low eventual glucose and lowers the temp, and then the meal
  follows. The model doesn't make that call as often.

**How accurate are the values AAPS decides on?**

| Value | Method | MAE | Bias | P90 |
|---|---|---|---|---|
| 4 h minimum | AAPS `minGuardBG` | 44 | −7 | 107 |
| | AAPS `minPredBG` | 41 | +4 | 95 |
| | MLP 10th percentile | **16** | −5 | **34** |
| | MLP mean | 22 | +19 | 50 |
| 3–4 h mean | AAPS `eventualBG` | 53 | −14 | 116 |
| | MLP mean | **29** | −15 | **64** |

- **The model forecasts the 4-hour minimum about 2.5 times more accurately**
  than `minGuardBG`, and the eventual glucose about twice as accurately as
  `eventualBG`.
- **As a suspend decision, the gain is modest.** At AAPS's suspend share the
  model flags about 10 points more of the time before a low. Per low, though,
  the hour before is covered about as often (81–86% vs 81%). At AAPS's catch
  rate it suspends about 5 points less of the time (27% vs 31%), at the cost
  of slightly less cover per low.
- **For reducing insulin**, the model catches more below-target outcomes
  (49% vs 43%) while on slightly less often. Both are imprecise, because a
  3–4-hour outcome depends on meals that have not happened yet.
- **The comparison favours the model in a way it cannot fix.** AAPS's values
  are "if nothing changes" forecasts, and AAPS acts on them: a suspension
  that prevents a low is scored as a false alarm, and its forecast as wrong.
  The model learned from outcomes with AAPS's reaction included. If the model
  drove the decision, AAPS would react differently, and the lows the model
  learned not to expect could come back. Settling whether it would dose
  better needs a model conditioned on planned insulin (a counterfactual
  forecast) or a simulation, not more offline scoring. The next section
  tries the first.

### What-if forecasts: glucose under an insulin plan

AAPS's curves answer "what if" questions. Checked in
`IobCobCalculatorPlugin.kt`:

- The IOB, COB and UAM curves cut the running temp off at "now", so they
  assume **profile basal and no more boluses**.
- The ZT curve assumes a **zero temp for the next 4 hours**.

`whatif.py` builds forecasts for both plans and compares four methods:

- **AAPS's curve** for that plan: ZT for zero temp, IOB for profile basal.
- **Plain MLP:** the regular model, which doesn't know the plan. It's a
  reference.
- **Learned plan model:** the MLP plus the activity of the insulin delivered
  from now on, using the same exponential curve. It is trained on what was
  actually delivered; to forecast a plan, the plan's insulin is fed in
  instead.
- **Hybrid:** the MLP predicts glucose under profile basal. It is trained on
  actual glucose with the effect of later insulin removed, using ISF ×
  insulin acted (ISF as AAPS logged it). The plan's effect is then added back
  the same way, so the insulin effect is fixed physics, not learned.

**The learned plan model is confounded and unusable.** Asked "zero temp
instead of profile basal?", it predicts *lower* glucose in every test sample
(−18 mg/dL at 30 minutes, −28 at 2 hours). AAPS zero-temps when glucose is
falling, so the model learned that little insulin ahead means a falling
glucose: cause and effect reversed. For the same reason it looks the most
accurate when given the actual delivery (MAE 15 vs 23 mg/dL at 1 hour):
AAPS's future delivery gives away the future glucose. This is the 2024
notebook's leak again, through insulin alone.

**Predicted effect of a zero temp instead of profile basal** (mg/dL, median
over test samples; positive means suspending raises glucose):

| Horizon | Physics (hybrid) | Learned plan model | AAPS ZT − IOB |
|---|---|---|---|
| 30 min | +0.7 | −18 | −4 |
| 1 h | +4 | −25 | −2 |
| 2 h | +18 | −29 | +5 |
| 4 h | +66 | −20 | — |

- **Suspending acts slowly.** Withholding profile basal changes glucose by
  about 1 mg/dL within 30 minutes, 4 within an hour, and 18 within 2 hours.
  So a suspension only helps against a low that is 1–2 hours or more away,
  which is why AAPS's guard looks 4 hours ahead. It also means the eat-now
  case (a low within 30 minutes) can't be fixed by suspending; only eating
  helps.
- **AAPS's ZT − IOB difference is not a pure insulin effect.** The IOB curve
  also carries the current deviation, decaying over an hour, and ZT does not.
  AAPS curves stop at 235 minutes, so there is no 4-hour value.

**Accuracy where the plan was actually followed** (test, no new carbs):

| Plan, horizon | n | AAPS curve | Plain MLP | Learned plan | Hybrid |
|---|---|---|---|---|---|
| Zero temp, 30 min | 19,500 | 21 (+2) | 15 (+9) | 14 (−5) | 16 (+10) |
| Zero temp, 1 h | 7,127 | 30 (−4) | 22 (+16) | 17 (−8) | 25 (+21) |
| Zero temp, 2 h | 834 | 40 (−25) | 27 (+19) | 24 (−20) | 41 (+37) |
| Profile basal, 30 min | 270 | 19 (−16) | 12 (−5) | 15 (−13) | 13 (−6) |
| Profile basal, 1 h | 68 | 21 (−16) | 12 (−4) | 15 (−13) | 14 (0) |

MAE in mg/dL, with the bias (predicted − actual) in brackets.

- **These stretches are selected by the outcome.** AAPS re-decides every
  5 minutes, so a zero temp lasts 2 hours only when glucose stayed low. Every
  method that doesn't see that choice predicts too high there: plain MLP
  +19, hybrid +37 at 2 hours. The learned model's good score comes from the
  confounding above. Profile basal is almost never followed for long (about
  1% of the time; n = 22 at 2 hours).
- **The hybrid isn't better than the plain MLP at forecasting**, and it is
  worse at long horizons when given the actual delivery (MAE 36 vs 25 at
  2 hours). Insulin AAPS gives for a rise it can't explain, such as an
  unlogged meal, is removed from the training target, but the rise it
  answered is left in. That makes the target harder to predict.

**What this means for dosing.** A forecast that learns the insulin effect
from closed-loop data gets the effect backwards, so it can't drive dosing.
The usable design is the hybrid: learn everything except the insulin
effect, and keep the insulin effect as physics, as oref does with ISF.
Whether the hybrid's suspend decisions would beat AAPS's still can't be
measured offline, because every outcome in the data is the outcome of
AAPS's choices. What it can do now is give AAPS-style "what if" curves next
to the plain forecast.

## Scenario B: eat-now warning

Warn when glucose is about to fall below 70 within 30 minutes. Both missed
lows and false alarms matter. The test period has about 10 lows a week,
counting brief dips. Scored the way a phone would show it:

- **Lows announced:** share of lows (a fall below 70 after 30 minutes above)
  with a warning in the 30 minutes before.
- **Minutes ahead:** time from the first warning to the low.
- **Alarm:** one notification. Warnings in consecutive slots, or less than 15
  minutes apart, count as one alarm.
- **Alarms followed by a low:** share of alarms after which glucose fell
  below 70 within 30 minutes of the alarm, or of any warning repeated during
  it. 50% means every second alarm was right and the other half were false
  alarms.

| Method (threshold) | Lows announced | Announced ≥ 15 min ahead | False alarms per week | Alarms followed by a low |
|---|---|---|---|---|
| AAPS IOB (min < 39) | 69% | 46% | 18 | 30% |
| Linear trend (min < 42) | 77% | 50% | 16 | 34% |
| MLP expected glucose (< 74) | 79% | 17% | 6.6 | 56% |
| **MLP P(low in 30 min) ≥ 0.3** | **88%** | **63%** | **12.6** | **43%** |
| MLP P(low in 30 min) ≥ 0.4 | 74% | 45% | 8.3 | 49% |
| MLP P(low in 30 min) ≥ 0.5 | 60% | 30% | 4.6 | 58% |

The classifier's operating points shift by a few points between training
runs: in an earlier run, 0.4 gave 87% announced with 11 false alarms a week.
Pick the threshold by the trade-off (lows announced against false alarms),
not by the probability value.

- **Thresholds on predicted glucose look precise but warn late:** the median
  is 5 minutes ahead, too late to eat in time. The probability output gives
  the most lead time.
- **Most false alarms are near misses or rescues:** 60–80% of them dip below
  80, and half to two thirds are followed by logged carbs or a rise of 15+
  mg/dL with no carbs logged (about 30% across all samples).
- **The rescue-carb assumption and "if nothing is eaten" training help the
  warning modestly:** at the same false-alarm rate, about 77% of lows are
  announced instead of 71% (1-hour model). They make no meaningful
  difference to dosing or to overall accuracy.

## Highs

### How often, and why

| Level | Episodes per week | Carbs logged in the 2 h before | Median minutes above | Time above |
|---|---|---|---|---|
| > 180 | 21 | 60% | 45 | 13% |
| > 250 | 3.9 | 63% | 30 | 1.6% |

An episode is a rise above the level after 30 minutes below it. Most highs
follow meals. The 40% without carbs logged in the 2 hours before are likely
unlogged meals, plus some stress, sensor or infusion-site effects.

### Accuracy when glucose is high

| Case | Horizon | Persistence: bias / MAE | AAPS IOB: bias / MAE | MLP: bias / MAE |
|---|---|---|---|---|
| Actual 180–250 | 1 h | −50 / 60 | −66 / 70 | −59 / 59 |
| Actual > 250 | 1 h | −96 / 99 | −107 / 108 | −112 / 112 |
| Coming down (now > 180) | 1 h | +54 / 63 | +9 / 44 | **−1 / 34** |
| Coming down (now > 180) | 2 h | +76 / 80 | −5 / 55 | **−7 / 34** |

Bias is predicted minus actual: negative means predicted too low.

- **No method predicts a rise before it starts.** Every method predicts
  50–110 mg/dL too low an hour before a high: the rise comes from a meal
  that hasn't happened, or hasn't been logged, at prediction time.
- **The model predicts the descent from a high well:** almost no bias, and
  less than half persistence's error at 2 hours. This is the case that
  matters for correction doses, where over-estimating the high leads to
  stacking insulin.

### High warnings

Warn while glucose is still at or below the level. Thresholds chosen on
validation for the best F1, as for lows.

| Event | Method (threshold) | Announced | Announced ≥ 15 min ahead | False alarms per week | Alarms followed by the event |
|---|---|---|---|---|---|
| > 180 within 30 min | AAPS IOB (max > 166) | 94% | 52% | 32 | 39% |
| | Linear trend (> 211) | 84% | 44% | 13 | 58% |
| | **MLP expected glucose (> 181)** | **82%** | **27%** | **5** | **78%** |
| | MLP P ≥ 0.3 | 85% | 67% | 15.5 | 54% |
| > 250 within 60 min | AAPS IOB (> 234) | 88% | 29% | 5.2 | 39% |
| | **MLP expected glucose (> 241)** | **95%** | **33%** | **3.9** | **48%** |
| | MLP P ≥ 0.3 | 72% | 51% | 3.2 | 48% |

Highs are easier to announce than lows because glucose usually climbs
gradually towards the level. As with lows, the expected-glucose thresholds
are precise but late (median 10 minutes ahead), and the probability output
gives more lead time.

### Acting on a predicted high

Glucose is in range (100–180) and a method predicts above 180 in 1 or 2
hours. How often would extra insulin have been right?

| Horizon | Method | Predicts a high, % of in-range time | Came true | Stayed below 140 | Went < 70 first | Share of highs predicted |
|---|---|---|---|---|---|---|
| 1 h | AAPS auto | 5.6% | 28% | 38% | 3.2% | 14% |
| | MLP expected glucose | 0.8% | 59% | 12% | 0.5% | 4% |
| | MLP 90th percentile | 19% | 30% | 32% | 2.2% | 55% |
| 2 h | AAPS auto | 5.9% | 13% | 61% | 11% | 6% |
| | MLP expected glucose | 0.2% | 51% | 17% | 2.7% | 1% |

- **AAPS's predicted highs 2 hours out are mostly wrong:** 61% stay below
  140, and 11% are preceded by a low. Dosing on them adds risk.
- **The model's expected glucose is cautious:** it rarely predicts a high
  from in range, and when it does it's right more often than not, with few
  lows first. But it predicts only a few percent of highs, because the meal
  is not known yet.
- **The upper percentiles show the possible rise:** the 90th percentile
  flags 55% of highs an hour out, but is right only 30% of the time. Useful
  as an upper band on the chart, not as a dosing signal.

## Sport

Heart rate from a Garmin data field (device name ending in `_DF`) is
recorded during an activity; watch face and widget readings are not. That
gives 1,715 sessions from 2020 on, about 240 a year, with a median length of
2.4 hours, covering 8% of all time. Heart rate itself is known 97–98% of the
time since 2021.

**Sport is where lows and errors concentrate** (test period):

| State | Share of time | Share of lows | MAE at 1 h |
|---|---|---|---|
| During sport | 14% | 21% | 38 |
| Up to 6 h after sport | 14% | 18% | 25 |
| Sport 6–24 h ago | 34% | 21% | 19 |
| No sport in 24 h | 37% | 40% | 21 |

From 2021 on, during sport compared with the rest of the time:

- Time below 70 doubles (7.2% vs 3.6%), and time above 180 is higher too
  (13.8% vs 10.5%).
- Insulin is 141% of profile basal, against 216% otherwise. Fewer boluses,
  and AAPS lowers basal.
- Logged carbs are 12 g/h against 7. But 44% of sessions of an hour or more
  have none logged, so food eaten during sport is often unknown to the
  model.
- During sport the model predicts too low (bias −14 mg/dL at 1 hour). Glucose
  holds up better than expected, probably from unlogged food.

**Activity inputs did not help.** Adding minutes of sport in the last 1, 3,
6 and 24 hours, hours since the last session, and heart rate during it
changed MAE by at most 0.4 mg/dL across three training seeds. That's no
more than seed-to-seed variation, during sport and after it alike. They are
in `build_features(..., sport=True)` but off by default. Likely reasons:

- The model already sees glucose falling.
- What moves glucose during sport is intensity and food, and neither is in
  the data: a session's type and planned length are unknown at its start,
  and snacks are often not logged.
- A delayed low after sport depends on how hard it was, which a mean heart
  rate captures poorly.

## Usual actions: eating and boluses

Can a forecast state what it assumes ("lands at 95 in 1 h if you eat about
15 g as usual")? `usual.py` predicts, for the next 30, 60 and 120 minutes,
whether carbs are logged (5 g or more), how many grams, and the insulin
delivered beyond the profile basal. Gradient boosting, test period.

**Eating is predictable as an event, not in grams.** Whether you eat within
30 minutes: AUC 0.80 (time of day and week alone: 0.70). How many grams:
only 9–19% of the variation explained. The probabilities hold up to about
30%; above that they run high (a predicted 57% is about 37%).

By the situation at the prediction time (30 minutes ahead):

| Situation (share of time) | Eats | + assumed rescue carbs | AUC: time / glucose + time / everything |
|---|---|---|---|
| < 70 (2%) | 18% | 18% | 0.57 / 0.58 / 0.63 |
| 70–80, falling (3%) | 20% | 45% | 0.57 / 0.60 / 0.63 |
| 80–180, steady (44%) | 7% | 7% | 0.79 / 0.81 / 0.83 |
| 80–180, rising 10+ (17%) | 8% | 8% | 0.70 / 0.75 / 0.84 |
| > 180, rising (7%) | 3% | 3% | 0.65 / 0.63 / 0.81 |

- With steady normal glucose, meals are well predicted, almost entirely from
  the time of day.
- Falling toward a low, it is close to a coin toss whether carbs follow.
- Above 180 and rising, eating is rare, and the model knows it; carbs and
  insulin already given help to tell the exceptions.

**Lows without logged carbs.** For 59% of the 705 lows in the test period,
no carbs were logged from 30 minutes before the drop below 70 until 15
minutes after it was back above 70 (39–66% per year since 2019). Looking
back 60 or 90 minutes changes this little (56%, 53%). Lows with and without
logged carbs are equally deep (median 61) and nearly as long (15 vs 20
minutes), so many probably had carbs that were not logged.

- Over all years, carbs were logged more often with more insulin on board
  (41% when suspended, 55% at 1–2 U) and much less often at night (33% vs
  47–58% by day).
- Since July 2025 neither matters: about 40% at every insulin level, 44% at
  night. With more than 2 U on board, lows are deepest (median 58) but carbs
  are logged for only 36%.

**Manual boluses follow clear rules.** Since July 2025, 3,155 manual
boluses (SMBs excluded):

| Reason | Share |
|---|---|
| Meal (carbs from 30 min before to 60 min after) and a correction | 31% |
| Correction above 180 | 29% |
| Correction above 120 and rising | 19% |
| Meal only | 13% |
| Correction at night (0–7 h) above 120, for in-range glucose at breakfast | 2% |
| Correction above 160, falling slowly | 2% |
| None of these | 5% |

Of the 5%, about half have carbs within 2 h before or 3 h after; 2% of
manual boluses have no visible reason. These rules have explained 86–96%
of manual boluses in every year since 2019.

**Insulin is hard to predict in amount.** Share of the variation explained
(everything as inputs): all insulin beyond the profile 27% / 25% / 22% at
30 / 60 / 120 minutes; AAPS's SMBs and temp basals 23% / 16% / 6%; manual
boluses 13% / 16% / 19%. With only glucose and time as inputs, AAPS's next
30 minutes is 15% explained: AAPS works from its own IOB, COB, targets and
autosens, so the glucose model learns AAPS's average effect, not its
decisions.

**Consequence for an "on the right path" forecast:** "as usual" assumptions
are too vague to steer by, and whether you eat at a low is close to random.
Better: the "if nothing is eaten" forecast the 4 h model already gives, plus
the physics effect of the options ("no carbs: 68 in 1 h; 10 g: 95; 20 g:
120"), with AAPS's average reaction to extra carbs estimated from past meals.

## Server model (15 and 30 minutes)

The loopk server predicts glucose 15 and 30 minutes after the newest
reading (`GET /api/prediction`, shown under the current glucose, and
recorded for every reading for the chart). Since 2026-10-20 it is the
benchmark candidate **server-insulin-carbs-synthetic**:

- **Inputs:** 2 hours of glucose, its mean over the last 1, 3 and 7 days,
  the time of day, and insulin and carbs. For insulin and carbs: activity
  in the past slots, committed for the next 30 minutes, and on board. Also
  the profile basal rate, and the assumed rescue carbs.
- **Training:** real samples plus the three kinds of synthetic insulin
  copies (see "Synthetic insulin data"), all outcomes (also after eating),
  calibrated on validation data.
- **Without insulin records** in the last 6 hours, the server gives no
  prediction, as training skipped such samples.

Columns of the comparison below, all on the test period:

- **MAE 15 / 30 min:** mean absolute error in mg/dL, on the slots with an
  AAPS IOB curve (as in "Standard benchmark"). Lower is better.
- **Low warning at 7 alarms a week, caught %:** share of lows warned of
  within 45 minutes before (30-minute warning). Higher is better.
- **+2 U now, wrong direction %:** share of samples where 2 more units raise
  the 30-minute forecast. Lower is better.
- **80% band holds %:** share of actual values within the 10th–90th
  percentile band at 30 minutes. 80 is right.

| Model | MAE 15 min | MAE 30 min | Low warning at 7 alarms a week, caught % | +2 U now, wrong direction % | 80% band holds % |
|---|---|---|---|---|---|
| server (glucose and time of day, until 2026-10-20) | 10.0 | 18.0 | 48.5 | – | 76.8 |
| server-level | 9.9 | 17.7 | 49.1 | – | 77.5 |
| server-insulin-synthetic | 9.9 | 17.8 | 45.2 | 5.5 | 76.9 |
| **server-insulin-carbs-synthetic** | **9.7** | **17.2** | **48.0** | **0.1** | **77.4** |

- Insulin without carbs is no better than glucose alone: insulin goes with
  meals, and without the carbs the network cannot tell a meal bolus from a
  correction. With carbs, the 30-minute error drops by 0.8 mg/dL.
- The forecast now responds to a dose: 2 more units lower it by 6.9 mg/dL at
  30 minutes (the measured effect is 8), and removing a recent meal bolus
  raises it by 32.
- **Low warning** ("low likely within 30 min") at a probability of 0.3 or
  more. On all test slots, the model `export.py` trained, these columns:
  - **announced %:** share of lows with a warning in the 30 minutes before
    them. Higher is better.
  - **≥ 15 min ahead %:** share warned at least 15 minutes before. Higher
    is better.
  - **false alarms / week:** alarms not followed by a low. Lower is better.

  | Threshold | Announced % | ≥ 15 min ahead % | False alarms / week |
  |---|---|---|---|
  | 0.2 | 94.5 | 75.6 | 18.8 |
  | **0.3 (in use)** | **88.0** | **64.3** | **13.5** |
  | 0.4 | 79.8 | 48.9 | 9.0 |

  The glucose-only model announced 90% (61% at least 15 minutes ahead)
  with 14 false alarms a week at its threshold of 0.4.
- **Accuracy of the exported model** (all 125,616 valid test slots, not only
  those with an AAPS curve): MAE 10.1 / 17.6 mg/dL at 15 / 30 minutes,
  Clarke zone A 92% / 78%, 80% band holds 77% / 78%.
- **Lows and highs are still where it fails:** at 30 minutes it predicts
  too high when the actual value is below 70 (bias +30 mg/dL) and too low
  when it is above 180 (bias −21).
- `modelling/export.py` trains it and uploads it (`--upload`) with an
  "Upload model" access token. The server stores models in the database and
  uses the newest. The model ships its insulin and carb curves and the rules
  for duplicates and rescue carbs. The server rebuilds the 5-minute grid
  from the raw records as `glupred/grid.py` does (`src/predict/grid.js`):
  profile switches and stored profiles, temp basals, extended boluses,
  duplicate boluses and carbs. Every model bundles checks: synthetic
  readings and treatments with the Python outputs. The server refuses an
  upload whose checks don't come out the same within 0.001 mg/dL. On 12
  real moments from 2025–26, the server's inputs matched Python's within
  1e-6. The server test `test/predict.test.js` runs the same comparison on a
  random network of the same shape.

## Standard benchmark

Every model test is scored the same way (`benchmark.py`, see AGENTS.md):
train 2019-05 – 2024-12, early stopping and calibration on 2025-01 – 2025-06,
test 2025-07 – 2026-10. Accuracy is measured on the 95,902 test slots where AAPS
made an IOB curve reaching 2 h, so all methods are scored on the same moments.
Warnings are counted on the whole test period: 641 lows (glucose below 70
after at least 30 minutes above) and 231 highs (above 250 after at least 30
minutes below). Figures are from the run of 2026-10-20; a retrained network
moves by a few tenths of a mg/dL.

**The models:**

- **no change:** glucose stays at the latest reading.
- **linear trend 15 min:** a straight line through the last 15 minutes,
  extended.
- **AAPS IOB, display curve, ZT, UAM:** AAPS's recorded curves (see
  "Comparison methods"). The display curve is COB while carbs are on board,
  else UAM, else IOB. UAM exists for only a third of the slots and is scored
  on those.
- **ridge, gbm:** ridge regression and gradient boosting on all inputs (2 h of
  glucose, insulin and carb activity, IOB, COB, profile basal, heart rate,
  time of day), 2 h ahead.
- **server:** the MLP the server ran until now: 2 h of glucose and the time
  of day, 30 minutes ahead.
- **server-level:** the same, plus the mean glucose of the last 1, 3 and 7
  days.
- **server-insulin-synthetic:** server-level plus insulin (activity in the
  past and committed for the next 30 minutes, IOB, profile basal), trained
  with synthetic insulin copies (see "Synthetic insulin data").
- **server-insulin-carbs-synthetic:** the same plus carbs (activity and COB,
  including assumed rescue carbs). **This is the new server model.**
- **all-level:** all inputs plus the glucose level, 2 h ahead, trained on
  "if nothing more is eaten" targets.
- **all-level-synthetic:** all-level with the synthetic insulin copies.

All MLPs (the server and all-level models) have two layers of 128 and 64
units and are calibrated (see Setup).

### Accuracy

Columns:

- **MAE 15 / 30 / 60 / 120 min:** mean absolute error of the forecast at
  that horizon, in mg/dL. Lower is better. The server models predict only
  30 minutes ahead, so they have no 60- and 120-minute value.
- **Bias 30 min:** mean of forecast minus actual at 30 minutes, in mg/dL.
  Positive: the forecast is too high. Closer to 0 is better.
- **Skill 30 min:** how much lower the 30-minute MAE is than "no change", in
  percent. Higher is better; negative means worse than "no change".

| Model | MAE 15 min | MAE 30 min | MAE 60 min | MAE 120 min | Bias 30 min | Skill 30 min % |
|---|---|---|---|---|---|---|
| no change | 12.7 | 22.4 | 35.7 | 42.8 | −2.1 | 0 |
| linear trend 15 min | 13.0 | 27.0 | 58.1 | 111.5 | 5.8 | −20.6 |
| AAPS IOB | 11.8 | 21.1 | 34.7 | 44.7 | −8.0 | 5.9 |
| AAPS display curve | 11.8 | 21.7 | 37.2 | 47.9 | −5.9 | 3.0 |
| AAPS ZT | 13.6 | 23.1 | 34.9 | 43.3 | −13.2 | −3.2 |
| AAPS UAM | 11.6 | 23.4 | 42.6 | 53.1 | 2.3 | −4.4 |
| ridge | 10.1 | 18.0 | 28.1 | 31.0 | −2.5 | 19.8 |
| gbm | 9.6 | 16.8 | 25.9 | 29.7 | −3.2 | 24.8 |
| server | 10.0 | 18.0 | – | – | −0.4 | 19.6 |
| server-level | 9.9 | 17.7 | – | – | 0.2 | 20.9 |
| server-insulin-synthetic | 9.9 | 17.8 | – | – | 2.3 | 20.7 |
| **server-insulin-carbs-synthetic** | **9.7** | **17.2** | – | – | **0.4** | **23.2** |
| all-level | 9.6 | 16.8 | 26.0 | 30.4 | −2.0 | 25.0 |
| all-level-synthetic | 9.6 | 17.0 | 26.2 | 30.1 | −2.1 | 24.2 |

- The networks and gradient boosting are 20–25% better than "no change" at
  30 minutes. AAPS's curves are within ±6% of it.
- AAPS's curves predict too low (−6 to −13 mg/dL at 30 minutes), the
  networks within ±2.5.
- Gradient boosting matches the best MLP, but is harder to port.

### Low warnings at the same alarm rate

Each method warns when its lowest forecast within the window is below a
threshold. The threshold is set so that each method gives 7 alarms a week,
so the methods can be compared at the same alarm rate. A warning is only
given while glucose is 70 or above. Alarms less than 15 minutes apart count
as one.

Columns:

- **Caught %:** share of the 641 lows with a warning before them, in the
  window plus 15 minutes: within 30 minutes for the 15-minute warning, within
  45 minutes for the 30-minute warning. Higher is better.
- **Correct %:** share of alarms followed by a low within that time. Higher
  is better; 100 − correct % are false alarms.

The 15-minute warning ("below 70 within 15 minutes") and the 30-minute
warning ("within 30 minutes") are scored separately.

| Model | 15 min: caught % | 15 min: correct % | 30 min: caught % | 30 min: correct % |
|---|---|---|---|---|
| linear trend 15 min | 35.7 | 54.5 | 30.4 | 46.7 |
| AAPS IOB | 33.9 | 52.1 | 39.3 | 61.9 |
| AAPS display curve | 33.7 | 52.1 | 39.2 | 60.8 |
| AAPS ZT | 33.5 | 50.9 | 30.6 | 46.0 |
| AAPS UAM | 16.4 | 24.8 | 16.8 | 27.6 |
| ridge | 42.0 | 64.4 | 40.9 | 63.0 |
| gbm | 49.8 | 75.7 | 49.3 | 74.8 |
| server | 48.4 | 73.6 | 48.5 | 73.8 |
| server-level | 49.1 | 74.5 | 49.1 | 74.8 |
| server-insulin-synthetic | 47.6 | 72.4 | 45.2 | 70.0 |
| **server-insulin-carbs-synthetic** | **49.8** | **75.5** | **48.0** | **73.8** |
| all-level | 47.3 | 71.7 | 47.4 | 72.4 |
| all-level-synthetic | 47.6 | 72.2 | 46.3 | 70.5 |

At 7 alarms a week, the networks catch about half of the lows, with three
out of four alarms correct. AAPS's curves catch about a third to two
fifths, with half to three fifths correct. "No change" never forecasts a
change, so it cannot warn.

### Low warnings at each method's own threshold

Here a method warns when its own forecast within 30 minutes is below 70, and
the MLPs also when their probability of a low within 30 minutes is 0.4 or
more (the server's "low likely" warning).

Columns:

- **Caught %:** share of lows with a warning in the 45 minutes before them.
  Higher is better.
- **Alarms / week:** alarms per week of test data. Lower is better, at the
  same caught %.
- **Correct %:** share of alarms followed by a low within 45 minutes. Higher
  is better.

| Model | Warning from | Caught % | Alarms / week | Correct % |
|---|---|---|---|---|
| linear trend 15 min | forecast < 70 | 99.4 | 50.4 | 23.1 |
| AAPS IOB | forecast < 70 | 99.4 | 59.5 | 19.5 |
| AAPS display curve | forecast < 70 | 99.4 | 58.6 | 19.8 |
| AAPS ZT | forecast < 70 | 75.8 | 21.6 | 38.0 |
| AAPS UAM | forecast < 70 | 18.4 | 8.8 | 23.3 |
| ridge | forecast < 70 | 84.4 | 16.8 | 55.7 |
| gbm | forecast < 70 | 78.5 | 13.1 | 65.3 |
| server | forecast < 70 | 68.8 | 10.9 | 67.8 |
| server | probability ≥ 0.4 | 89.7 | 22.5 | 43.9 |
| server-level | forecast < 70 | 69.3 | 11.1 | 67.1 |
| server-level | probability ≥ 0.4 | 91.6 | 23.4 | 43.3 |
| server-insulin-synthetic | forecast < 70 | 69.6 | 11.9 | 63.8 |
| server-insulin-synthetic | probability ≥ 0.4 | 89.2 | 22.0 | 45.1 |
| **server-insulin-carbs-synthetic** | **forecast < 70** | **66.6** | **11.1** | **64.9** |
| **server-insulin-carbs-synthetic** | **probability ≥ 0.4** | **86.7** | **20.6** | **46.4** |
| all-level | forecast < 70 | 39.5 | 5.7 | 74.1 |
| all-level | probability ≥ 0.4 | 84.7 | 18.5 | 50.2 |
| all-level-synthetic | forecast < 70 | 58.7 | 9.2 | 67.9 |
| all-level-synthetic | probability ≥ 0.4 | 88.1 | 20.2 | 47.8 |

AAPS's IOB curve announces nearly every low, at about 60 alarms a week, four
out of five false. The networks' forecasts give 6–12 alarms a week; their low
probability catches more lows (85–92%) at 19–23 alarms a week.

### High warnings

The same counting for highs: a warning when the highest forecast within 30
minutes is above 250, while glucose is 250 or below. An alarm is correct if
glucose goes above 250 within 45 minutes.

Columns:

- **7 / week: caught %** and **7 / week: correct %:** as for lows, at a
  threshold that gives 7 alarms a week. Higher is better.
- **Own: caught %**, **own: alarms / week**, **own: correct %:** at the
  method's own forecast above 250.

| Model | 7 / week: caught % | 7 / week: correct % | Own: caught % | Own: alarms / week | Own: correct % |
|---|---|---|---|---|---|
| linear trend 15 min | 74.5 | 41.7 | 100.0 | 23.9 | 17.5 |
| AAPS IOB | 81.4 | 44.8 | 20.3 | 1.7 | 44.8 |
| AAPS display curve | 48.1 | 29.1 | 49.8 | 7.2 | 28.9 |
| AAPS ZT | 72.3 | 39.4 | 3.5 | 0.6 | 23.5 |
| AAPS UAM | 38.1 | 24.5 | 38.1 | 7.0 | 24.5 |
| ridge | 91.8 | 52.1 | 75.8 | 4.4 | 65.9 |
| gbm | 93.5 | 52.8 | 75.3 | 4.3 | 67.8 |
| server | 92.6 | 52.4 | 75.3 | 4.6 | 62.6 |
| server-level | 92.6 | 52.6 | 79.7 | 4.8 | 63.8 |
| server-insulin-synthetic | 96.1 | 54.0 | 90.5 | 5.9 | 59.8 |
| **server-insulin-carbs-synthetic** | **93.5** | **52.6** | **78.8** | **4.9** | **61.9** |
| all-level | 91.8 | 51.7 | 74.0 | 4.5 | 63.4 |
| all-level-synthetic | 90.0 | 50.5 | 66.7 | 4.0 | 65.0 |

Highs (231) are rarer than lows, so 7 alarms a week is generous for them:
the networks catch 90–96%.

### Response to insulin and carbs

The test samples are changed as if a dose had been logged, and the change of
the forecast is compared with the measured effect of insulin: 11.7 mg/dL per
unit in total, about 4 mg/dL by 30 minutes and 8.5 by 60 (see "Synthetic
insulin data"). Only models with insulin inputs have values.

Columns:

- **Minutes:** the horizon the next columns are read at: 60 for the 2-hour
  models, 30 for the server models.
- **+2 U now, wrong direction %:** share of samples where 2 more units now
  raise the forecast. Lower is better; 0 is right.
- **+2 U now, change / expected:** mean forecast change divided by the
  measured effect (−8 mg/dL at 30 minutes, −17 at 60). 1 is right; 0.3
  means the model sees only a third of the effect.
- **Meal bolus removed:** mean forecast change in mg/dL when the bolus of a
  recent meal (2 U or more with 20 g or more carbs) is removed. The measured
  effect says about +32 mg/dL at 30 minutes.
- **+20 g carbs now:** mean forecast change in mg/dL for 20 g more carbs
  logged now. It should be positive.

| Model | Minutes | +2 U now, wrong direction % | +2 U now, change / expected | Meal bolus removed | +20 g carbs now |
|---|---|---|---|---|---|
| ridge | 60 | 0.0 | 0.3 | 17.9 | 10.8 |
| gbm | 60 | 7.4 | 0.6 | 27.7 | 16.4 |
| server-insulin-synthetic | 30 | 5.5 | 0.7 | 31.8 | – |
| **server-insulin-carbs-synthetic** | **30** | **0.1** | **0.9** | **32.1** | **13.2** |
| all-level | 60 | 30.0 | 0.3 | 26.2 | 19.1 |
| all-level-synthetic | 60 | 0.6 | 1.0 | 34.6 | 22.3 |

Without synthetic data, the closed loop teaches the network that big doses
come with rising glucose: in 30% of samples 2 more units raise its 2-hour
forecast. The synthetic copies fix the direction and the size.

### Stability, uncertainty band and drift

Columns:

- **Revision in 5 min:** mean change, in mg/dL, of the forecast for the same
  moment 30 minutes ahead when it is made again 5 minutes later. Lower means
  a steadier line on screen. "No change" scores 5.5 only because the
  reading itself moves.
- **80% band holds %:** share of actual values within the 10th–90th
  percentile band at 30 minutes. 80 is right.
- **Largest half-year bias:** the largest |bias| at 30 minutes in any
  half-year of the test period, in mg/dL. Lower is better.
- **MAE when actual < 70:** 30-minute MAE on the slots where glucose turned
  out below 70, in mg/dL. Lower is better.

| Model | Revision in 5 min | 80% band holds % | Largest half-year bias | MAE when actual < 70 |
|---|---|---|---|---|
| no change | 5.5 | – | 0.1 | 28.0 |
| linear trend 15 min | 15.1 | – | 0.1 | 26.7 |
| AAPS IOB | 14.2 | – | 14.1 | 20.4 |
| AAPS display curve | 15.6 | – | 12.1 | 21.3 |
| AAPS ZT | 5.7 | – | 15.4 | 24.0 |
| AAPS UAM | 15.8 | – | 2.9 | 39.3 |
| ridge | 9.7 | – | 4.2 | 31.3 |
| gbm | 9.0 | – | 4.6 | 27.8 |
| server | 9.8 | 76.8 | 1.6 | 30.2 |
| server-level | 9.3 | 77.5 | 0.4 | 31.0 |
| server-insulin-synthetic | 9.1 | 76.9 | 2.4 | 31.3 |
| **server-insulin-carbs-synthetic** | **8.9** | **77.4** | **1.4** | **30.2** |
| all-level | 7.9 | 73.8 | 2.7 | 33.2 |
| all-level-synthetic | 8.1 | 71.8 | 2.8 | 29.4 |

AAPS's IOB curve is the most accurate method when glucose ends up low
(MAE 20 against about 30 for the networks), because it predicts too low
in general. The networks predict too high before lows. This is the
remaining weak spot.

## Synthetic insulin data

In the closed loop, insulin follows glucose: big doses come with meals and
rises, and AAPS reacts to every rise with SMBs. A network trained on this
data reads insulin as a sign that glucose is going up. Before the synthetic
data, 2 extra units raised the 2-hour forecast in 21% of test samples, and
10 extra units raised it by 49 mg/dL on average.

**How a synthetic sample is made** (`glupred/synthetic.py`): take a real
sample, add (or remove) a dose of `units` given `ago` slots before now, and
change:

- the insulin inputs exactly as a logged dose would change them: activity in
  the past slots, committed activity for the coming slots, and IOB
  (`dose_inputs`; a test checks this against `build_features` on a grid with
  the dose);
- glucose, in the 2-hour history as in the targets, by −11.7 mg/dL per unit
  times the share of the effect reached at that moment, along an
  exponential insulin curve peaking at 35 minutes and done by 2 hours. Values
  are clipped to the sensor range (40–400).

The effect is measured, not taken from AAPS's ISF (`corrections.py`). Night
corrections (manual boluses with no carbs around them, 23:00–6:00; 177 of
216 matched) were compared with moments without one of the same glucose,
15-minute trend, IOB and time of day. Per unit, glucose was 9 mg/dL lower after 1 hour, 11
after 1.5 hours and 10 after 2 hours. AAPS's reaction is included: by 2
hours it held back about 0.3 U of its own insulin per unit corrected.
AAPS's ISF (median 32 mg/dL per unit) expects −22 mg/dL by 2 hours, twice
the measured effect. Synthetic data with an ISF-sized effect made
real-data accuracy worse. The same comparison by day found no effect,
because daytime corrections come with unlogged food.

**Three kinds of copies**, added to the real training and validation data:

- **random:** −1 to +5 U at a random time in the last 2 hours, one copy of
  every sample;
- **peak or falling:** +2 to +5 U in the last 30 minutes, where glucose
  stopped rising after a rise of 15 mg/dL or more in the hour before, or
  falls 5 mg/dL or more per 15 minutes from above 120 (about 20% of
  samples). It shows that a big dose is not always followed by a rise;
- **meal bolus removed:** up to 2 hours after a meal bolus (2 U or more with
  20 g or more carbs within 15 minutes, the only manual bolus in 2 hours),
  the bolus taken away, so glucose rises by what it would have lowered (8%
  of samples). This assumes AAPS would not make up for it with more SMBs,
  so the real rise would probably be smaller.

**Results** (`synthetic.py`, 2-hour model on all inputs). Columns:

- **MAE 60 min (validation):** mean absolute error 60 minutes ahead on
  2025-01 – 2025-06, in mg/dL. Lower is better.
- **+2 U now, 60 min:** mean forecast change, in mg/dL, for 2 more units now,
  on test samples. The measured effect is −16.9.
- **+10 U now, 60 min:** the same for 10 units. The measured effect is −73.5.
- **Wrong direction %:** share of test samples where 2 more units raise the
  60-minute forecast. Lower is better.

| Trained on | MAE 60 min (validation) | +2 U now, 60 min | +10 U now, 60 min | Wrong direction % |
|---|---|---|---|---|
| real data only | 20.6 | −7.9 | 19.1 | 21.2 |
| + random | 21.0 | −17.8 | −56.2 | 0.5 |
| + peak or falling | 20.7 | −14.1 | −52.4 | 2.8 |
| + meal bolus removed | 20.9 | −6.9 | 20.4 | 23.1 |
| + peak or falling + meal bolus removed | 20.9 | −16.3 | −58.6 | 1.1 |
| + all three | 21.1 | −18.5 | −62.4 | 0.1 |

- All three together give the right direction almost always and about the
  measured size for usual doses. Real-data accuracy costs up to 0.5 mg/dL
  at 60 minutes, and 0.2 at 30 minutes in the benchmark.
- The meal copies alone do not help. They only work together with copies
  that show insulin without a rise.
- The model is still less sure for large doses (−62 against −74 for 10 U):
  the copies stop at 5 U.
- What the copies cannot teach: AAPS's reaction to a dose that was never
  given, and the effect of insulin at other times of day than the night
  corrections it was measured on.

## Caveats

- One person's data. The test period is 59 weeks of valid data.
- AAPS's interventions are in the outcomes. The model predicts "what
  happens, given AAPS keeps looping", not "what happens if nothing is done".
- Some lows are probably not predictable from these inputs: exercise not yet
  visible in heart rate, missing or wrong carb entries.
- Sensor noise and occasional duplicate uploads (two readings in one slot,
  which are averaged) limit short-horizon accuracy.

## Next steps

1. **Warning lead time:** train and choose thresholds for "below 70 in 15–30
   minutes" (and the same for highs), so warnings come early enough to act on.
2. **Dosing:** the plan-conditioned forecast has to keep the insulin effect
   as physics (the hybrid in "What-if forecasts"). Next: check its ISF ×
   insulin effect against glucose changes after insulin that AAPS didn't
   choose, such as manual correction boluses with no carbs, or profile
   changes. If it holds there, it is the candidate for AAPS-style curves.
3. **Model tuning:** more epochs and capacity, insulin peak per insulin type,
   training on recent years only. Check whether highs after logged meals are
   predicted better than unlogged ones, to see how much carb logging is worth.
4. **Sport:** activity type, distance and effort from Strava (in the atweb
   database), and AAPS exercise temporary targets, may say more than heart
   rate does. A planned activity entered in advance would give the model the
   information it lacks at the start of a session.
5. **Server prediction:** done for 15 and 30 minutes from glucose, its level,
   insulin and carbs, with synthetic insulin data (see "Server model").
   Next: retrain on recent data before each upload (the export trains up to
   2024 and validates on 2025-H1), and benchmark a 1-hour server model.
6. **"Am I on the right path":** a forecast of what happens if nothing is
   eaten, with the effect of 10 or 20 g added by physics and AAPS's average
   reaction to carbs estimated from past meals. Check it on meals with
   natural variation in grams. Rerun the 1–4 h model and the what-if
   physics on the deduplicated insulin data first.
