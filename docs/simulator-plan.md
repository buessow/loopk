# Plan: a what-if simulator for profile and loop settings

## Goal

Answer two kinds of question with your own data:

1. **One decision:** "With SMB basal minutes at 45 instead of 30, or ISF
   10% stronger, what would the loop have done at 14:05?"
2. **A period:** "Had these settings been in place last week, how would
   glucose, lows, highs and insulin have looked?"

The AAPS algorithms are ported to JavaScript in loopk, and their inputs are
rebuilt from loopk's database. A replay check shows that the port decides
as AAPS did before any what-if result is trusted.

## Starting point

- **Your AAPS:** 3.4.2.6-dev, the build in `../aaps-dev` (commit
  423a4502f2). Its device status shows:
  - SMB with the Oref1 sensitivity plugin from February 2024, with Dynamic
    ISF for part of the time;
  - AutoISF 3.0.1 since 22 Oct 2026;
  - no smoothing, and the insulin type "3" (ultra-rapid, Fiasp/Lyumjev by
    AAPS's numbering; to confirm);
  - a step-by-step console log on 416,000 runs, which shows where a port
    goes wrong.
- **Licence:** AAPS is AGPL-3.0, so a port is a derived work. Put loopk (or
  at least `src/oref/`) under AGPL-3.0, with a LICENSE file and a note in the
  README. AGPL also asks that people who use loopk over the network can get
  its source; a public repository covers that.
- **Conformance cases:** `aaps-dev/app/src/androidTest/assets/results/`
  holds 85 recorded algorithm calls with input and output: 22 AutoISF, 16
  SMB, 44 Dynamic ISF and 3 AMA. They test the port on its own, without
  rebuilt inputs.
- **What not to reuse:** the modelling work showed that simulating glucose
  from scratch with AAPS's ISF and carb ratio is worse than "no change"
  beyond an hour (MAE 51 against 43 mg/dL at 2 h, `results/simulate.md`).
  The ISF check also found that insulin acts at about 0.4–0.5 times what
  AAPS's ISF assumes (`results/sensitivity.md`). So the simulator only models
  the *difference* in insulin, on top of the glucose actually measured, and
  uses a body ISF that is separate from the profile's.

## Design

```
                 settings + profile (baseline or changed)
                                 │
DB ──► inputs (glucose status, IOB array, meal data, autosens, TDD,
       current temp, profile at t) ──► determine-basal (port) ──► decision
         ▲                                                          │
         └──────── simulated doses and glucose ◄── pump + body ◄────┘
```

- **`src/oref/`:** the port, close to the Kotlin file by file, with the same
  names, so a new AAPS release can be ported by diff.
- **`src/oref/inputs/`:** rebuilds the inputs AAPS had, from loopk's
  entries, treatments and profiles.
- **`src/simulate/`:** runs the loop forward with changed settings, with a
  pump model (bolus step, basal rounding, SMB interval) and a body model.

## Phase 1: port the algorithms

Port these files from `aaps-dev` (commit 423a4502f2):

| AAPS (Kotlin) | loopk | Lines |
|---|---|---|
| `plugins/aps/.../openAPSSMB/DetermineBasalSMB.kt` (includes Dynamic ISF) | `src/oref/determinebasalsmb.js` | 1,155 |
| `plugins/aps/.../openAPSAutoISF/DetermineBasalAutoISF.kt` | `src/oref/determinebasalautoisf.js` | 1,157 |
| `OpenAPSAutoISFPlugin.kt`: `autoISF`, `interpolate`, `withinISFlimits`, `loop_smb`, `determine_varSMBratio`, the iobTH and exercise ratio from `invoke` | `src/oref/autoisf.js` | about 400 of 1,027 |
| `OpenAPSSMBPlugin.kt`: `calculateVariableIsf`, the TDD weighting and the profile assembly | `src/oref/dynisf.js`, `src/oref/profile.js` | about 200 |
| `DetermineBasalResult.kt`, rounding and constraints (max basal, max IOB, hard limits by age) | `src/oref/result.js`, `src/oref/constraints.js` | about 300 |

- Keep AAPS's quirks: rounding (`round`, `roundBasal`), the reason-string
  wording and the order of checks. The reason text and console log are what
  replay compares against.
- Note the source file and commit in each file's header.
- **Tests:** in `test/oref.test.js`, copy the 85 cases to
  `test/fixtures/oref/` and require the same output for each: rate, duration,
  units, eventualBG, insulinReq, the predictions and the reason. Cases from
  older algorithm versions that the current Kotlin no longer reproduces are
  listed and skipped, with the reason.
- **Done when:** every applicable SMB, Dynamic ISF and AutoISF case matches
  exactly.

## Phase 2: rebuild the inputs, and the replay check

Port the input side, against loopk's tables:

| Input | AAPS source | Notes |
|---|---|---|
| Glucose status: delta, short and long average delta; for AutoISF the parabola fit, `bg_acceleration` and `dura_ISF` | `GlucoseStatusCalculatorSMB.kt`, `GlucoseStatusCalculatorAutoIsf.kt`, bucketing in `AutosensDataStoreObject.kt` | Leave out Random-source readings as now (`SIMULATED_SOURCES`). |
| IOB array (48 × 5 min ahead), `iobWithZeroTemp`, `lastBolusTime` | `IobCobCalculatorPlugin.calculateIobArrayForSMB`, `InsulinOrefBasePlugin.kt`, `IobTotalExtension.kt` | Temp basals count as the difference from profile basal; extended boluses are converted. Peak and DIA come from `insulin_configuration` or the insulin type. |
| Meal data: COB, `slopeFromMaxDeviation` and `slopeFromMinDeviation`, last carb time | `IobCobOref1Worker.kt`, `SensitivityOref1Plugin.kt` | Deviations per 5 min, minimum carb impact, absorption cutoff. |
| Autosens ratio | `SensitivityOref1Plugin.kt` | 8 h and 24 h windows, limited to autosens min and max. |
| TDD for Dynamic ISF | `TddCalculator` use in `OpenAPSSMBPlugin.kt` | 1 day, 7 days and the weighted last 8 h. |
| Profile at a time, temp target, current temp | loopk's `profileEvents` and `basalRates` (`src/predict/grid.js`) | Percentage and time shift already handled. |
| Glucose quality: max IOB 0 for "doubled values" | `BgQualityCheckPlugin.processBgData` and `applyMaxIOBConstraints` | Two readings at most 20 s apart among the last 10 or so (about 50 min) set max IOB to 0. This explains your max IOB 0 runs (see Decisions). Count deleted readings too, since AAPS had them. |

**Settings history.** Many settings are not uploaded: SMB basal minutes, UAM
SMB minutes, max IOB, max basal, the AutoISF weights, the SMB delivery
ratio and the SMB and UAM switches. They come from three places, in this
order:

1. a new `loop_settings` table (migration 0015: setting, value, valid from),
   entered on a settings page;
2. values read from reason texts and console logs, such as `maxBolus`,
   `max_iob`, "SMB delivery ratio set to fixed value 0.5", "iobTH=100%" and
   "autoISF weights disabled";
3. the configuration columns (`aps_configuration`,
   `sensitivity_configuration`, `safety_configuration`), with AAPS's
   defaults last.

Every value carries where it came from, so a replay mismatch can be traced
to a guessed setting.

**Replay check.** `scripts/oref-replay.js` runs the port on recorded runs
in a period, then compares field by field:

- the inputs: BG, IOB, COB, autosens ratio and `variable_sens` against the
  stored ones and the console log;
- the outputs: eventualBG, minPredBG, minGuardBG, insulinReq, the rate and
  the SMB.

It reports match rates and the first stage that differs: inputs, settings
or algorithm. Its output stays in the scratchpad or in
`modelling/results/`, out of git, because it is health data.

- **Done when:** on the last 30 days of AutoISF and the last 30 days of
  SMB, at least 95% of runs reach the same action (rate within 0.05 U/h,
  SMB within one bolus step) and eventualBG lies within 5 mg/dL. The
  mismatches are explained: late uploads, edited treatments, unknown
  settings.
- Runs from older AAPS versions (see `configuration_version`) are reported
  separately; the port only claims fidelity for 3.4.2.6.

## Phase 3: what-if for one decision

- `POST /api/simulate/run { time, changes }` rebuilds the inputs at that
  run, decides with the baseline and with the changed settings and profile,
  and returns both: predictions, eventualBG, insulinReq, SMB, rate, reason
  and the limits hit.
- **Changes** can be any setting from the settings history, the profile
  (ISF, carb ratio, basal and targets, as a schedule or a percentage), the
  algorithm (SMB, Dynamic ISF, AutoISF) and the temp target.
- **UI:** a "What if" panel on a selected loop run and on each miss, with
  the baseline filled in, editable fields, and the two decisions side by
  side over the prediction curves.
- **MCP:** a `simulate_run` tool, plus `get_loop_settings`.
- **Tests:** unchanged settings reproduce the recorded decision; larger
  SMB minutes do not lower the SMB; max IOB 0 gives no SMB.

## Phase 4: simulating a period

From the start of the period, every 5 minutes:

1. Rebuild the inputs from the simulated state. The simulated SMBs and temp
   basals replace AAPS's. Your carbs, manual boluses, profile switches and
   temp targets stay as they were.
2. Decide with the changed settings, then deliver through the pump model:
   the temp basal runs until the next decision or its end, SMBs respect the
   SMB interval and the bolus step.
3. **Glucose by difference:**
   `simulated BG(t) = actual BG(t) − Σ ISF_body(s) × (insulin acting_sim(s) − insulin acting_actual(s))`.
   - Everything AAPS can't see (meals, sport, sensor noise, the liver)
     comes from reality, so the error grows only with the insulin
     difference.
   - The result is clipped to 39–401 mg/dL, as the sensor is.

**Body ISF.** The profile ISF at 100% times a factor k. The default k
comes from the ISF check (0.4–0.5 on clean stretches) and can be changed
on the page. Three runs, at the low, middle and high k, give an
uncertainty band. The profile ISF you test only changes what the loop
believes, never the body.

**Long periods.** A simulation restarts from the real state every 6 hours,
because the body model drifts over days. Each window is reported, and the
windows are summed.

**Results, simulated against actual:**

- time in the five ranges;
- lows below 70 and below 54, as count and time;
- highs above 250;
- total insulin, SMB count and largest SMB;
- the misses that disappear and the ones that appear.

**Checks:**

- With unchanged settings, the simulation reproduces the actual doses and
  glucose, apart from the replay mismatches of phase 2.
- More insulin never raises simulated glucose.
- A 30-day simulation finishes within seconds, so autosens and COB must be
  computed step by step, not from scratch at each run.

**Known limits, stated on the page:**

- You would have reacted differently. For example, rescue carbs eaten for a
  low that the simulation avoids still count. An option leaves out carbs
  logged below 80 mg/dL when simulated glucose stays above 100. It is off by
  default.
- Lows are not linear: counter-regulation and sensor floors make them
  shallower than modelled.
- The body ISF is uncertain, and it is estimated from closed-loop data.

Results are trustworthy for hours and modest changes, and the band shows
how much.

## Phase 5: page and agent tools

- **`/simulate` page:**
  - pick a period;
  - a settings form with the baseline filled in, highlighting what you
    change;
  - Run;
  - a glucose chart, actual against simulated with the band, and the doses
    of both;
  - the results table, with every column explained above it;
  - a "Simulate" link from each miss.
- **MCP:** a `simulate_period` tool with the same changes, and the
  description of the method and its limits in the tool description.
- Add the simulator to `docs/aaps-algorithms.md`, so Claude reviews can
  suggest settings and check them.

## Order and sizes

| Step | Size | Can ship alone |
|---|---|---|
| Licence and conformance fixtures | small | yes |
| Phase 1: port and conformance tests | large | no (not visible) |
| Phase 2: inputs, settings history, replay check | largest | yes: the match rate itself shows how far loopk's view is from AAPS's |
| Phase 3: one-decision what-if | medium | yes |
| Phase 4: period simulation | medium | yes |
| Phase 5: page and MCP | medium | yes |

Phase 2 decides the rest: if the inputs can't be rebuilt closely enough,
what-if results inherit the error. Stop and rethink if the replay check
stays below about 90% on the last 30 days.

## Decisions

- **Settings history:** your settings last changed long ago. The settings
  history starts with one entry of the current values, valid from February
  2024. The algorithm comes from each run's device status: SMB, SMB with
  Dynamic ISF (`running_dynamic_isf`), or AutoISF since 22 Oct 2026. AutoISF
  has its own setting keys, so the AutoISF settings are entered separately.
- **Max IOB 0 was not Low Glucose Suspend.** AAPS sets max IOB to 0 in four
  cases: Low Glucose Suspend, doubled glucose values, an expired app build,
  and a max IOB setting of 0. Over the last 120 days, 1,511 runs had max
  IOB 0, and 97.5% of them had two readings at most 20 s apart in the 50
  minutes before. Other runs had such a pair only 7.8% of the time. So it is
  AAPS's glucose quality check. Almost all the pairs are two G7 Native
  readings, with a few from the deleted Random source. Two consequences:
  - The replay must port the quality check (phase 2).
  - "What if the duplicates were filtered?" is a natural first question for
    the period simulation. The duplicates hold back SMBs and extra basal for
    up to about 50 minutes each time.
- **Dynamic ISF is simulated too.** Phases 1 and 2 cover it. The TDD inputs
  need the treatments from 7 days before a period, so the simulator loads
  them, and the replay check scores Dynamic ISF runs separately.
