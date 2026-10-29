# How AAPS doses: algorithms and settings explained

## About this guide

AAPS decides every 5 minutes (or as often as your sensor sends readings) how much insulin to give, using one of three dosing algorithms and an optional way to estimate how sensitive you are today. This guide explains, in plain words, what each algorithm does, how sensitivity is estimated, and what the main settings change.

- **Who it is for:** people who loop with AAPS and want to understand their settings, not developers.
- **What it was checked against:** the AAPS source code on branch `master-3.4` (commit 423a4502f2, 17 Oct 2026), plus the official AAPS documentation. Where the two differ, the code wins, and the guide says so.
- **How to read it:** start with *The basics*. The later sections can be read on their own. Setting names are given as they appear in the app, with the internal key in `code` font so you can search for it.

This is not medical advice. Change one setting at a time, and talk to your diabetes team before large changes.

## The basics

Each time a new glucose reading arrives (usually every 5 minutes, depending on your sensor), AAPS predicts where your glucose is heading and changes your insulin so it ends near your target. It never gives a large bolus on its own: it only sets temporary basal rates and, with SMB, small automatic boluses.

### One loop run, step by step

1. **Read the inputs.** Current glucose and how fast it is changing (the last 5, 15 and 45 minutes), insulin on board (IOB), carbs on board (COB), your profile (basal, ISF, carb ratio, target) and any temp target.
2. **Adjust for sensitivity (optional).** If a sensitivity method is on, AAPS multiplies your basal by a ratio and adjusts your ISF. See *How sensitivity is estimated*.
3. **Predict.** It draws up to four curves for the next hours: insulin only (IOB), insulin plus logged carbs (COB), unannounced meal (UAM), and zero-temp (what happens if basal stops now).
4. **Decide.** From the lowest safe prediction and the eventual glucose, it works out how much insulin is missing or too much (`insulinReq`).
5. **Act within limits.** Too much insulin: lower or stop the basal. Too little: raise the basal and, with SMB, give a small bolus. Every action is cut to the safety limits (max IOB, max basal, SMB size).
6. **Wait for the next reading** and do it all again. Each run corrects the last one, so small mistakes do not add up.

### Safety rules that always apply

- **Low glucose suspend.** If any prediction drops below a threshold, AAPS stops adding insulin. The threshold is halfway between your low target and 40 mg/dL (target 100 → 70 mg/dL), or the higher *LGS threshold* if you set one. The 40 mg/dL is fixed in the code. The LGS (Low Glucose Suspend) threshold is an optional setting in the OpenAPS SMB preferences; it can only raise the threshold, so a value below the computed one has no effect.
- **No SMB when glucose jumps.** If glucose rose more than 20% in one reading (often sensor noise), SMBs pause for that run.
- **Max basal.** A temp basal is never higher than the smallest of: your *max basal* setting, 3 × your highest profile basal, and 4 × the current profile basal.

### Short glossary

| Term | Meaning |
| --- | --- |
| BG | Blood glucose, here the sensor reading |
| IOB | Insulin on board: insulin given that is still working |
| COB | Carbs on board: logged carbs not yet absorbed |
| ISF | Insulin sensitivity factor: how far 1 U lowers glucose (mg/dL or mmol/L per U). Smaller ISF = stronger insulin need |
| Carb ratio (IC) | Grams of carbs covered by 1 U |
| Temp basal (TBR) | A basal rate that replaces the profile basal for 30 minutes or less |
| SMB | Super micro bolus: a small automatic bolus |
| UAM | Unannounced meal: a rise AAPS treats as food you did not log |
| TDD | Total daily dose: all insulin delivered in a day |
| Deviation | How much glucose changed compared with what insulin alone should have done |
| Sensitivity ratio | A factor for basal and ISF. Above 1 = you need more insulin (resistant), below 1 = less (sensitive) |

## The dosing algorithms

AAPS offers three dosing algorithms (in *Config Builder → APS*): AMA, SMB and AutoISF. Dynamic ISF is not a separate algorithm but a switch inside SMB that replaces your profile ISF with a calculated one.

|  | AMA | SMB | SMB + Dynamic ISF | AutoISF |
| --- | --- | --- | --- | --- |
| In the app | OpenAPS AMA | OpenAPS SMB | OpenAPS SMB, *Enable dynamic sensitivity* on | Auto ISF |
| Extra insulin by | Temp basals only | Temp basals and SMBs | Temp basals and SMBs | Temp basals and SMBs, larger SMBs possible |
| Handles meals you did not log (UAM) | No | Yes | Yes | Yes |
| ISF comes from | Profile ÷ autosens ratio | Profile ÷ autosens ratio | Formula from TDD and current glucose | Profile ÷ factor from glucose behaviour |
| Basal multiplied by | Autosens ratio | Autosens ratio | TDD ratio (if *Adjust sensitivity* is on), else 1 | Autosens ratio |
| Max IOB counts | Basal insulin only | All insulin | All insulin | All insulin |
| Status | From 2017, for beginners | Standard choice | For advanced users | Community extension, for advanced users |

### AMA (Advanced Meal Assist)

The oldest algorithm. It only adjusts the temp basal and never gives boluses on its own.

The problem it solves after a meal bolus: the new insulin makes AAPS predict a drop, so without help it would cut your basal and undo part of the meal dose. *Bolus snooze* stops that: for some time after a bolus, AMA holds off on lowering the basal.

Its limits: it has no detection of unlogged meals, and its only tool against a rise is a higher basal, which acts slowly.

### SMB (Super Micro Bolus)

The standard algorithm. When insulin is missing it gives **half** of the missing amount as a small bolus, and may repeat that every few minutes. One SMB is never larger than 30 minutes of your current basal (settable), and none is given within 3 minutes of the last bolus (settable). UAM lets it act on rises you did not log. Max IOB here limits all insulin, including your own boluses.

### Dynamic ISF (a switch inside SMB)

With *Enable dynamic sensitivity* on, the ISF is no longer read from your profile. It is calculated every run as:

```latex
\text{ISF} = \frac{1800}{\text{TDD} \times \ln\left(\frac{\text{BG}}{\text{divisor}} + 1\right)}
```

**How to read it.** 1800 / TDD is the *1800 rule*, a clinical rule of thumb from the 1990s: 1 U of rapid-acting insulin lowers glucose by about 1800 ÷ your daily insulin (mg/dL). The 1800 has no physical meaning; it is the constant that matched patients' real correction doses (older rules used 1500 for regular insulin; in mmol/L the rule is about 100 / TDD; see [John Walsh's explanation of the 1800 rule](https://www.diabetesnet.com/diabetes-tools/insulin-dose-guide/correction-factor)). The ln term then adjusts that baseline for current glucose: it equals 1 at divisor × 1.72 (about 112 mg/dL for Fiasp), is larger above that (smaller ISF, stronger corrections) and smaller below. The model comes from user data collected by Chris Wilson ([his talk with Loop and Learn](https://www.youtube.com/watch?v=oL49FhOts3c), which the AAPS docs cite); the log form was added later by the Dynamic ISF developers ([Diabettech, 2022](https://www.diabettech.com/dynamicisf-an-update/)). Neither has been published as a study.

Examples for Fiasp (divisor 65), ISF in mg/dL per U:

| BG (mg/dL) | TDD 30 U | TDD 40 U | TDD 60 U |
| --- | --- | --- | --- |
| 70 | 82 | 62 | 41 |
| 100 | 64 | 48 | 32 |
| 150 | 50 | 38 | 25 |
| 200 | 43 | 32 | 21 |
| 250 | 38 | 29 | 19 |

The 1800-rule baselines are 60, 45 and 30 for comparison.

- **Higher glucose gives a smaller ISF**, so corrections get stronger when you are high and gentler near a low.
- **TDD is a blend:** 33% from the last 8 hours (last 4 hours weighted most), 34% from the 7-day average, 33% from yesterday. The *DynISF adjustment factor* (default 100%) scales it. A profile percentage scales it too: an 80% factor with an 80% profile switch gives 0.64.

  ```latex
  \text{TDD} = \left(0.33 \cdot \text{TDD}_{8h} + 0.34 \cdot \text{TDD}_{7d} + 0.33 \cdot \text{TDD}_{24h}\right) \times \text{adjustment factor} \times \text{profile \%}
  ```

  ```latex
  \text{TDD}_{8h} = 3 \times \left(1.4 \cdot \text{TDD}_{0\text{–}4h} + 0.6 \cdot \text{TDD}_{4\text{–}8h}\right)
  ```

  The × 3 scales the 8-hour total up to a full day, so all three parts are daily amounts. TDD\_7d and TDD\_24h both use calendar days (midnight to midnight, today not included): TDD\_7d is the average of the last 7 full days, and TDD\_24h is yesterday, not a rolling 24 hours. Only TDD\_8h follows the clock.
- **divisor** depends on your insulin: 55 for rapid-acting (Novorapid, Humalog), 65 for ultra-rapid (Fiasp), 75 for Lyumjev.
- The prediction curves also use the ISF at the *predicted* glucose, so AAPS doses for where you are heading.
- With Dynamic ISF on, **autosens is not used at all.** The basal ratio then comes only from the sub-option *Adjust sensitivity* (see next section).
- It needs 7 full days of insulin history. Without it, AAPS falls back to normal SMB and shows a notice.

### AutoISF

A separate plugin with its own dosing code. It starts from your **profile ISF** and makes it stronger or weaker depending on how glucose behaves right now. No TDD is used. Each effect has its own weight, and every weight defaults to 0 (off):

- **Glucose level:** above target ISF gets stronger, below target weaker (*higher / lower ISF-range weight*).
- **Rising after a meal** (*postprandial weight*).
- **Accelerating or slowing down** (*bgAccel / bgBrake weight*).
- **Long high plateau** (*dura\_ISF weight*).

**How each factor is calculated.** Each effect gives a factor; above 1 means stronger. The ISF used is *profile ISF ÷ final factor*. Weights are your settings; the examples use target 100 mg/dL and sample weights. (From `OpenAPSAutoISFPlugin.kt`, AAPS master, Oct 2026.)

- **Glucose level.** AAPS shifts glucose so that *target + 10* counts as 100: x = BG − target + 90. It reads a fixed curve f(x) (50 → −0.5, 60 → −0.5, 80 → −0.3, 90 → −0.2, 100–110 → 0, 150 → 0.5, 180 → 0.7, 200 → 0.7, straight lines between and beyond), then multiplies by the higher-range weight if x > 100, else the lower-range weight. Factor = 1 + weight × f(x). Example: BG 190, weight 0.5 → 1 + 0.5 × 0.7 = 1.35. If this factor is below 1, only it and the acceleration factor are used; the rest are skipped.

  Example with profile ISF 50 mg/dL/U, target 100, both range weights 0.5, autosens 1.0:

  | BG (mg/dL) | Curve value | Factor | ISF used |
  | --- | --- | --- | --- |
  | 70 | −0.5 | 0.75 | 67 |
  | 100 | −0.2 | 0.90 | 56 |
  | 120 | 0 | 1.00 | 50 |
  | 160 | 0.5 | 1.25 | 40 |
  | 190 | 0.7 | 1.35 | 37 |
  | 250 | 0.7 | 1.35 | 37 |

  The curve is flat below 70 and above 190 mg/dL (at target 100), so the factor stops changing there. These numbers only apply if *autoISF\_min* is ≤ 0.75 and *autoISF\_max* is ≥ 1.35. Both default to 1.0, which would cancel every row.
- **Rising after a meal.** Only when BG is above target + 10 and still rising. Factor = 1 + 5-min delta × postprandial weight. Example: delta 6 mg/dL, weight 0.02 → 1.12.
- **Accelerating or slowing down.** AAPS fits a parabola to recent readings. Only if the fit is good (r² ≥ 0.9): factor = 1 + acceleration × weight × fit share. Fit share runs from 0 at r² 0.9 to 1 at r² 1.0. Acceleration is in mg/dL per (5 min)²: positive means the curve bends upward, negative downward. Which weight is used depends on where you are.

  Here bgAccel and bgBrake are two settings in the AutoISF preferences: *Weight while BG accelerates* (`bgAccel_ISF_weight`) and *Weight while BG decelerates* (`bgBrake_ISF_weight`), each 0–1, default 0 = off. bgAccel applies when the curve bends away from target, bgBrake when it bends back toward it:
  - **Above target**, bending up (rise speeding up), acc > 0: bgAccel, stronger. Bending down (rise slowing or fall speeding up), acc < 0: bgBrake, weaker.

    ```latex
    \begin{gathered} \text{acc} > 0 \text{, no override}: \quad \text{factor} = 1 + \text{acc} \times \text{bgAccel} \times \text{fit share} \\ \Rightarrow \text{factor} > 1 \end{gathered}
    ```

    ```latex
    \begin{gathered} \text{acc} < 0: \quad \text{factor} = 1 + \text{acc} \times \text{bgBrake} \times \text{fit share} \\ \Rightarrow \text{factor} < 1 \end{gathered}
    ```
  - **Below target**, bending down, acc < 0: bgAccel, weaker. Bending up (fall slowing), acc > 0: bgBrake, stronger, halved when acc > 1.

    ```latex
    \begin{gathered} \text{acc} < 0: \quad \text{factor} = 1 + \text{acc} \times \text{bgAccel} \times \text{fit share} \\ \Rightarrow \text{factor} < 1 \end{gathered}
    ```

    ```latex
    \begin{gathered} 0 < \text{acc} \le 1 \text{, no override}: \quad \text{factor} = 1 + \text{acc} \times \text{bgBrake} \times \text{fit share} \\ \text{acc} > 1 \text{, no override}: \quad \text{factor} = 1 + 0.5 \times \text{acc} \times \text{bgBrake} \times \text{fit share} \\ \Rightarrow \text{factor} > 1 \end{gathered}
    ```
  - **30-min override:** if the parabola has a *minimum* below target within the next 30 min, the sign of the weight flips, so the factor goes below 1 (weaker). This replaces both acc > 0 cases above, above target as well as below. A maximum gets no such check.

    ```latex
    \begin{gathered} \text{acc} > 0: \quad \text{factor} = 1 - \text{acc} \times \text{bgBrake} \times \text{fit share} \\ \Rightarrow \text{factor} < 1 \end{gathered}
    ```

  In AAPS the fit window is not fixed: it tries every window from the last 4 readings back to 47 min and keeps the one with the best r². The examples above fit all 10 readings. Without the override, the second case (below target, bending up) would use +bgBrake and get a factor above 1.
- **Long high plateau.** AAPS counts how many minutes glucose has stayed within ±5% of its running average. If that is at least 10 min and the average is above target: factor = 1 + (minutes / 60) × (dura weight / target) × (average − target). Example: 2 h at 180, weight 0.5 → 1 + 2 × 0.005 × 80 = 1.8.
- **Combining.** AAPS takes the largest of the four factors; if glucose is slowing down (acceleration factor < 1) it multiplies by that. The result is clamped between *autoISF\_min* and *autoISF\_max*, then merged with the autosens or temp-target ratio. Note that autoISF\_max defaults to 1.0, so nothing gets stronger until you raise it.

The strongest of these wins and is limited by *autoISF\_min / autoISF\_max* (both default 1.0, which turns the effect off). AutoISF can also allow larger SMBs (*SMB delivery settings*). The autosens ratio still scales the basal, and for ISF the stronger of autosens and AutoISF wins; they do not multiply.

## How sensitivity is estimated

AAPS uses at most one *sensitivity ratio* per loop run. It multiplies your profile basal by it and, unless Dynamic ISF is on, divides your profile ISF by it. Which method makes the ratio depends on your algorithm and two switches, as the table below shows.

Read each row left to right: your algorithm, the one switch that matters for it, and what the ratio then does to basal and ISF. Only the TDD ratio has no upper or lower limit.

| Method | Looks at | Window | Limited to | Used when |
| --- | --- | --- | --- | --- |
| Autosens, Oref1 plugin | Deviations (median) outside meals | 8 h and 24 h; the lower ratio wins | autosens min/max, default 0.7–1.2 | *Use Autosens* on, Dynamic ISF off |
| Autosens, AAPS plugin | Deviations (median) outside meals | *Autosens period*, default 24 h | autosens min/max | as above |
| Autosens, Weighted average plugin | Deviations, recent ones weighted more | *Autosens period* | autosens min/max | as above |
| TDD ratio (*Adjust sensitivity*) | Insulin of last 24 h ÷ average of last 7 days, corrected for carbs | 24 h vs 7 calendar days | **Not limited** | Dynamic ISF on and *Adjust sensitivity* on |
| Temp target | Height of a temp target | While the target runs | autosens max | AutoISF only, with *High / Low temptarget raises / lowers sensitivity* |

### Autosens in plain words

Every 5 minutes AAPS compares how glucose actually moved with how your insulin alone should have moved it. That difference is a *deviation*. Autosens takes the **median** of many deviations, so a single bad hour barely counts.

- **Left out:** times while carbs are absorbing, the first 45 minutes after a carb entry, and unannounced meals once insulin on board is above 2 × basal. Positive deviations below 80 mg/dL count as zero.
- **Reset:** after a site change or a profile switch it starts collecting again.
- **Blind spot:** food you neither log nor bolus looks like resistance at first, until the loop's SMBs push IOB above 2 × basal.

### TDD ratio in plain words

The ratio is *insulin of the last 24 hours ÷ daily average of the last 7 days*. If you also ate more carbs than usual in the last 24 hours, the ratio is lowered by 60% of that difference. It reacts to how much you dosed, not to how glucose behaved, so it feeds on itself: more insulin raises the ratio, which gives more insulin. See *Pitfalls* for two more problems.

### Temp targets

- **Sensitivity raises target / Resistance lowers target:** when the ratio says you are sensitive, the target is raised; when resistant, it is lowered. Both are on by default in this branch.
- **High temp target raises sensitivity** (AutoISF only): a temp target of 160 mg/dL runs 50% basal, 140 runs 60%, 120 runs 75% (set by *Half basal exercise target*, default 160). In SMB this is always off.

## Settings reference

Defaults are the values in this code; a setup wizard may set others. Start with the safety limits: they decide how far any algorithm can go.

### Safety limits

| Setting (key) | Default | What it does |
| --- | --- | --- |
| Max U/h a temp basal can be set to (`openapsma_max_basal`) | 1.0 U/h | Hard cap on any temp basal |
| Max daily safety multiplier (`openapsama_max_daily_safety_multiplier`) | 3 | Temp basal at most 3 × your highest profile basal |
| Current basal safety multiplier (`openapsama_current_basal_safety_multiplier`) | 4 | Temp basal at most 4 × the current profile basal |
| Maximum total IOB (`openapsmb_max_iob`), SMB and AutoISF | 3.0 U | No extra insulin while IOB, boluses included, is above this |
| Maximum basal IOB (`openapsma_max_iob`), AMA | 1.5 U | Same, but counts only insulin the loop added |
| Max bolus (`treatmentssafety_maxbolus`) | 3.0 U | Largest bolus you can give by hand |
| LGS threshold | off | Raises the glucose level below which insulin is suspended (60–100 mg/dL) |

### SMB and UAM

| Setting (key) | Default | What it does |
| --- | --- | --- |
| Enable SMB (`use_smb`) | on | Allows small automatic boluses |
| Enable SMB always (`enableSMB_always`) | on | SMBs at any time. Needs a CGM source that AAPS marks as having advanced filtering |
| Enable SMB with COB (`enableSMB_with_COB`) | on | SMBs while carbs are absorbing |
| Enable SMB after carbs (`enableSMB_after_carbs`) | on | SMBs for 6 h after any carb entry |
| Enable SMB with temp targets (`enableSMB_with_temptarget`) | on | SMBs with a low temp target (below 100 mg/dL) |
| Enable SMB with high temp targets (`enableSMB_with_high_temptarget`) | off | Off means a high temp target (e.g. sport) stops SMBs |
| Enable UAM (`use_uam`) | on | Treats unexplained rises as food and may give SMBs for them |
| SMB max minutes (`smbmaxminutes`) | 30 | One SMB is at most this many minutes of current basal |
| UAM SMB max minutes (`uamsmbmaxminutes`) | 30 | Same, when IOB already covers the logged carbs |
| SMB interval (`smbinterval`) | 3 min | Minimum time between two boluses |
| Always use short average delta (`always_use_shortavg`) | off | Uses the 15-minute trend instead of the last 5 minutes; helps with noisy sensors |
| Min carbs impact (`openaps_smb_min_5m_carbimpact`) | 8 mg/dL per 5 min (AMA: 3) | Assumed carb absorption when glucose shows none, so COB still goes down |
| Max absorption time (`absorption_cutoff`) | 6 h | Carbs still on board after this are dropped |

### Autosens

| Setting (key) | Default | What it does |
| --- | --- | --- |
| Use Autosens feature (`openapsama_useautosens`) | on | Turns autosens on. Hidden and unused while Dynamic ISF is on |
| Autosens min / max (`autosens_min`, `autosens_max`) | 0.7 / 1.2 | Limits the autosens ratio. Max also limits temp-target ratios |
| Autosens period (`openapsama_autosens_period`) | 24 h | Window for the AAPS and Weighted plugins (Oref1 always uses 8 h and 24 h) |
| Sensitivity raises target (`sensitivity_raises_target`) | on | Ratio below 1 raises your target |
| Resistance lowers target (`resistance_lowers_target`) | on | Ratio above 1 lowers your target |
| Autosens adjust targets (`autosens_adjust_targets`), AMA | on | The AMA version of the two above |

### Dynamic ISF

| Setting (key) | Default | What it does |
| --- | --- | --- |
| Enable dynamic sensitivity (`use_dynamic_sensitivity`) | off | Replaces profile ISF with the TDD and glucose formula. Turns autosens off |
| DynISF adjustment factor (`DynISFAdjust`) | 100% (1–300) | Scales the TDD in the formula. Higher = stronger insulin |
| Adjust sensitivity (`dynisf_adjust_sensitivity`) | off | Multiplies basal by the 24 h ÷ 7-day TDD ratio. Off = ratio 1 |

### AutoISF

| Setting (key) | Default | What it does |
| --- | --- | --- |
| Enable ISF adaptation by glucose behaviour (`openapsama_enable_autoISF`) | off | Turns the weights below on |
| autoISF\_min / autoISF\_max | 1.0 / 1.0 | How weak / strong ISF may become. 1.0 = no change. Use max above 2.5 with great care |
| higher / lower ISF-range weight | 0 | Stronger ISF above target / weaker below target |
| postprandial weight (`pp_ISF_weight`) | 0 | Stronger ISF while glucose is rising |
| bgAccel / bgBrake weight | 0 | Stronger ISF when the rise speeds up / weaker when it slows |
| dura\_ISF weight | 0 | Stronger ISF on long high plateaus |
| SMB delivery ratio (`openapsama_smb_delivery_ratio`) | 0.5 | Share of missing insulin given as one SMB (SMB fixes this at 0.5) |
| SMB delivery ratio min / max / BG range | 0.5 / 0.5 / 0 | Lets the share rise from min at target to max at target + range |
| SMB max range extension | 1 | Allows SMBs above the max-minutes limit by this factor |
| maxIOB threshold percent for SMB (`iob_threshold_percent`) | 100% | Stops SMBs once IOB reaches this share of max IOB |
| High / Low temptarget raises / lowers sensitivity | off | Temp target changes the ratio (see previous section) |
| Half basal exercise target | 160 mg/dL | Temp target at which basal runs at 50% |
| Even-target SMB switch (`Enable alternative activation of SMB always`) | off | SMB *always* only when the active target is an even number, so you can switch it with the target |

## Pitfalls and recommendations

The TDD ratio behind *Adjust sensitivity* has two flaws in this code, and both showed up in real loop data: it swings most in the late evening, and nothing limits it.

### Pitfalls

- **TDD ratio is unlimited.** The ratio goes straight into the basal without the autosens min/max limits. Over 60 days of one user's data, 25% of loop runs had a ratio above 1.2 and 8% below 0.7; the highest was 3.09, which tripled the basal.
- **TDD ratio jumps at midnight.** Its top part is a rolling 24 hours, but the 7-day average is made of whole calendar days and never includes today. Late in the evening the 24 hours are almost all “today”, compared against an average without it, so a heavy or light day shows at full size. At midnight the day joins the average and the ratio falls back. In the data the ratio's spread was 0.32 by day and 0.42 at 21–23 h, right before sleep.
- **TDD feeds on itself.** More insulin raises TDD, which raises the ratio and makes the ISF smaller, which gives more insulin. The Dynamic ISF formula's TDD has the same loop, weighted to the last 4 hours, so ISF drops right after a big meal bolus.
- **Unlogged food fools autosens.** A meal you neither log nor bolus looks like resistance until IOB reaches 2 × basal. Logging the carbs, even without a bolus, prevents it.
- **Max IOB means different things.** In AMA it counts only loop insulin; in SMB and AutoISF it counts all insulin, your own boluses too. Switching from AMA needs a higher value.
- **Duplicate glucose readings set max IOB to 0.** AAPS's glucose quality check (`BgQualityCheckPlugin`) looks at the newest readings (about the last 50 minutes). If two of them are at most 20 seconds apart, it calls them "doubled values" and limits max IOB to 0 U until the pair has aged out: no SMBs and no basal above the profile. The reason text then shows `max_iob 0.0`. Other causes of max IOB 0 are Low Glucose Suspend mode and an expired app build. Duplicates usually come from two glucose sources, or one source sending readings twice.
- **A high temp target stops SMBs** unless *Enable SMB with high temp targets* is on, and in SMB it does not lower the basal ratio.

### Recommendations

1. **Leave *Adjust sensitivity* off** unless you have a reason; it is off by default. With it off, Dynamic ISF still adapts ISF to glucose, and the basal ratio is 1.
2. **For a glucose-dependent ISF without the TDD loop, consider AutoISF** with only the *higher / lower ISF-range* weights set, *autoISF\_max* modest (for example 1.3–1.5), and *Use Autosens* on.
3. **Before leaving Dynamic ISF**, set your profile ISF from what Dynamic ISF used near target, so the change is not abrupt. Expect highs to come down more slowly with a fixed ISF.
4. **Log carbs, even rough ones**, so autosens and COB stay honest.
5. **Change one setting at a time** and watch a few days before the next change.

Open question: whether these TDD-ratio issues are known upstream has not been checked; it may be worth a report to the AAPS developers.

## What-if simulations in loopk

loopk runs its own copies of these algorithms (AAPS 3.4.2, ported line by
line) on inputs it rebuilds from the uploaded data. With them it answers
"what if" questions about settings:

- **One decision** (`simulate_run`, or the simulate page): the loop decides
  again at a recorded run with changed settings, profile, algorithm, temp
  target or sensitivity ratio. The result is exact for that decision: which
  limit held an SMB back, and what a larger limit would have given. It
  doesn't say what glucose would have done next.
- **A period** (`simulate_period`): the loop doses a period again with the
  changes. Glucose is the measured glucose minus the effect of the insulin
  difference, at a body ISF share k of the profile ISF (default 0.45, with a
  band at k ± 0.15). The simulation restarts from reality every 6 hours.

Read the results with these limits in mind:

- **Reproduction.** Unchanged, the copies reproduce about 93% of AutoISF
  and 87% of Dynamic ISF decisions. A run with `reproduces: false`
  compares the change against loopk's unchanged decision, not AAPS's.
- **The person's own reactions are unchanged.** Carbs eaten for a low that
  the simulation avoids still count.
- **Real lows are shallower than modelled** (counter-regulation, the
  sensor's floor).
- **k is uncertain.** Trust results for hours and modest changes, and give
  the band.
- **Settings AAPS doesn't upload** (SMB minutes, max IOB and others) are
  read from the logs or entered on the simulate page. `get_loop_settings`
  says where each value came from.

## Sources

The code was read on branch `master-3.4` of AAPS (commit 423a4502f2); the official documentation pages below were opened on 22 Oct 2026.

| What | Where |
| --- | --- |
| SMB dosing, SMB size and limits, low glucose suspend | `plugins/aps/.../openAPSSMB/DetermineBasalSMB.kt` |
| Dynamic ISF formula, TDD blend, TDD ratio, carbs correction | `plugins/aps/.../openAPSSMB/OpenAPSSMBPlugin.kt` (lines 266–300, 390–415) |
| 7-day TDD from calendar days | `implementation/.../stats/TddCalculatorImpl.kt` |
| AutoISF factors and how they combine with autosens | `plugins/aps/.../openAPSAutoISF/OpenAPSAutoISFPlugin.kt` |
| Autosens (Oref1, AAPS, Weighted) | `plugins/sensitivity/.../Sensitivity*Plugin.kt` |
| Which deviations autosens counts | `workflow/.../iob/IobCobOref1Worker.kt` |
| Setting names, help texts, defaults | `plugins/aps/src/main/res/values/strings.xml`, `core/keys/.../DoubleKey.kt`, `IntKey.kt`, `BooleanKey.kt` |
| Dynamic ISF (official docs) | [DynamicISF](https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/DynamicISF.html) |
| Autosens, SMB, max IOB, safety limits (official docs) | [Key AAPS features](https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/KeyAapsFeatures.html) |

Where the documentation and the code differ, this guide follows the code:

- **Max IOB default for AMA:** the docs say 2 U, the code 1.5 U.
- **SMB with temp targets:** the docs say any temp target, the code only a low one (below 100 mg/dL).
- **TDD ratio:** the docs do not mention the carbs correction, the calendar-day 7-day average, or that the ratio has no limits.
