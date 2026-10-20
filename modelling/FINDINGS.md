# Glucose prediction: findings

Status as of 2026-10-19. Offline study on loopk's data (one person, AAPS
closed loop, 2019-04 – 2026-10). Reproduce with `uv run python train.py`
(60-minute model comparison), `uv run python scenarios.py` (4-hour model,
dosing, eat-now and high scenarios) and `uv run python whatif.py` (forecasts
under an insulin plan); full tables land in `results/`. Figures
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
- Highs (above 180) happen about 3 times a day, mostly after meals. No
  method predicts a rise before it starts. Once glucose is rising, high
  warnings work well, and while coming down from a high the model predicts
  the descent accurately (bias about −1 mg/dL at 1 hour), which matters for
  not over-correcting.

## Setup

- **Data:** sensor glucose, boluses (including SMBs), temp basals, profile
  switches and profiles, extended boluses, carbs, heart rate, and AAPS's
  predicted curves, read from Postgres (`glupred/load.py`).
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
- **Unlogged rescue carbs:** carbs are logged for only 19–40% of lows. When
  glucose falls below 70 after 30 minutes above it, and no carbs were logged
  in the previous 30 minutes, 15 g is assumed eaten. The rule uses only the
  past, so live predictions can apply it too.
- **"If nothing is eaten":** training ignores glucose targets that come after
  any new carbs (logged or assumed), so the glucose outputs predict what
  happens without eating.
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

## Server model (15 and 30 minutes)

The loopk server predicts glucose 15 and 30 minutes after the newest
reading (`GET /api/prediction`, shown under the current glucose). Inputs
compared for these horizons (test MAE in mg/dL):

| Inputs | 15 min | 30 min |
|---|---|---|
| Glucose (last 2 h) + time of day | 10.4 | 18.4 |
| + heart rate | 10.3 | 18.4 |
| + AAPS's logged IOB and insulin activity | 10.2 | 18.0 |
| + heart rate and own insulin model | 10.0 | 17.3 |
| + own insulin and carb models (full) | 9.9 | 17.2 |

- **The server uses glucose and time of day only.** Insulin is worth about
  1 mg/dL at 30 minutes. Computing it would mean porting the basal, profile
  and temp-basal timeline to the server. Carbs and heart rate add nothing
  at these horizons.
- **Accuracy (test):** Clarke zone A 92% at 15 minutes and 77% at 30
  minutes. The 10th–90th percentile range holds the actual value 77% of the
  time, against the nominal 80%.
- **Low warning** ("low likely within 30 min"), at P ≥ 0.4: 90% of lows are
  announced, 61% at least 15 minutes ahead, with about 14 false alarms a
  week. At 0.3, 94% are announced, but with 19 false alarms a week.
- `modelling/export.py` trains it and uploads it (`--upload`) with an
  "Upload model" access token. The server stores models in the database and
  uses the newest. Every model bundles checks: synthetic readings with the
  Python outputs. The server refuses an upload whose checks don't come out
  the same within 0.001 mg/dL. The server test `test/predict.test.js` runs
  the same comparison on a random network of the same shape.

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
5. **Server prediction:** done for 15 and 30 minutes from glucose alone
   (see "Server model"). Next: insulin inputs, longer horizons, and a chart
   overlay.
