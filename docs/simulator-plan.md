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

## Status (25 Oct 2026)

All five phases are built. The plan below is kept as written; this section
says where the result differs from it.

**Where it lives.** One directory, `src/oref/`, instead of the planned
`src/oref/inputs/` and `src/simulate/`:

| File | What it does |
|---|---|
| `determinebasal.js`, `autoisf.js`, `dynisf.js`, `format.js` | The algorithms: oref1 SMB with Dynamic ISF, and AutoISF (phase 1) |
| `glucose.js`, `iob.js`, `autosens.js`, `profile.js` | AAPS's bucketing and glucose status, IOB, COB and autosens, profiles by local time |
| `inputs.js` | Rebuilds the inputs of a run from the database (`Replayer`) |
| `settings.js` | The settings history: `loop_settings` (migration 0015), configuration, logs, defaults |
| `replay.js`, `scripts/oref-replay.js` | The replay check |
| `simulate.js` | One decision again with changes (phase 3) |
| `period.js` | A period dosed with changes (phase 4) |
| `routes.js` | `/api/simulate/run`, `/period` and `/settings` |

The page is `/simulate` (`public/simulate.html`, `simulate.js`,
`simulate-model.js`). A click on a loop run on the glucose page opens its
what-if; each miss has a "Simulate" button. The page draws the glucose
page's chart (`public/glucosechart.js`, shared with `app.js`): a period
with the simulated glucose, band, basal, SMBs and loop decisions over the
actual data, and a hover comparing each 5-minute step; one decision
three hours either side of the run with the recorded and changed curves.
A period is picked like on the glucose page (3 h to 14 d, earlier /
later). Changes can swap in another stored profile (`profile.name`, at the
recorded percentage unless one is given). The MCP tools are
`simulate_run`, `simulate_period` and `get_loop_settings`
(`src/mcp/simulate.js`).

**Conformance (phase 1).** All 89 cases in `test/oref.test.js` match.
Synthetic cases go further: `scripts/oref-cases.js` generates random loop
runs (glucose from 39 to 400, falling and rising, stale and flat; negative
to high IOB; carbs, temp targets, mmol/L, and random settings of the SMB,
UAM, Dynamic ISF and AutoISF options), AAPS's own determine_basal runs them
in a unit test (`scripts/aaps/LoopkCasesTest.kt`, at commit 423a4502f2, the
build on the phone), and the port's results are compared field by field,
with the four prediction curves and the reason text. Of 30,000 cases
(10,000 per algorithm), all now match exactly. They found one difference:
the port wrote "-0" in the reason where Java's `Math.round` gives 0.
`test/orefsynthetic.test.js` keeps AAPS's results for 691 of them.

**Replay check (phase 2)**, 30 days to 25 Oct 2026 09:00 UTC, and 30 days
to 20 Mar 2026 (winter, Dynamic ISF only). *Runs*: loop runs replayed.
*Same action*: % of runs where the port sets the same temp (within 0.05
U/h) and SMB (within 0.05 U) as AAPS did. *Eventual within 5*: % of runs
with the eventual glucose within 5 mg/dL. *IOB same* and *COB same*: % of
runs whose rebuilt IOB and COB match AAPS's (within 0.015 U and 0.5 g).
Higher is better in all four.

| Algorithm | Period | Runs | Same action (%) | Eventual within 5 (%) | IOB same (%) | COB same (%) |
|---|---|---|---|---|---|---|
| AutoISF | to 25 Oct | 815 | 97.4 | 98.2 | 100.0 | 97.2 |
| SMB + Dynamic ISF | to 25 Oct | 7,832 | 92.9 | 90.8 | 96.8 | 92.5 |
| SMB | to 25 Oct | 3 | 100.0 | 100.0 | 100.0 | 100.0 |
| SMB + Dynamic ISF | to 20 Mar | 8,669 | 74.8 | 79.9 | 98.3 | 93.3 |

AutoISF passes the 95% goal; Dynamic ISF comes close since 25 Oct. The
winter ran AAPS 3.3.3.0-dev-d, and most of its runs that differ have the
same inputs and differ in the algorithm; the port follows 3.4. Four input
bugs were found by comparing with the phone's own AAPS preferences,
database and logs (25 Oct):

- **Bucketing grid.** AAPS's calculation worker works on a copy of its
  glucose store, and the copy drops the store's reference time
  (`AutosensDataStoreObject.clone`). So each bucketing of irregular
  readings anchors its 5-minute grid on the newest reading (the log says
  "Adjusted time" = the newest reading), not on a grid set at app start.
  loopk did the latter, fitted to the recorded glucose, which put the
  newest bucket's minute before the run where AAPS's came after it; COB
  and the deviation slopes behind the UAM forecast were then one step
  ahead. Fixing it took Dynamic ISF from 87.2% to 92.9% and AutoISF from
  96.2% to 97.4%, and an unchanged day now simulates with the actual TIR
  and insulin.

- **Local time.** AAPS reads profiles by the phone's clock, which follows
  daylight saving and travel; the profile's time zone name (here
  Africa/Mbabane, UTC+2 all year) doesn't. loopk now takes the clock from
  the `utc_offset` AAPS writes on each temp basal (`PhoneClock` in
  `profile.js`). This took AutoISF's IOB from 92.6% to 100% after the end
  of summer time, and the winter's variable ISF from 84.8% to 97.8%.
- **DIA.** Effective profile switches before April 2026 were uploaded with
  a DIA of −1 ms (unset). AAPS's insulin plugin uses at least 5 hours
  (`MIN_DIA`), and so does loopk now. Without it the winter replay had no
  IOB and only 32.8% same action.
- **Settings over time.** `loop_settings` entered on the page apply from
  their time, and the replay and a period use the settings in effect at
  each run (`loadSettingsTimeline`), not those at the end.

Against the phone (AAPS database copied over adb, 25 Oct): boluses, SMBs,
temp basals and profiles from 22 to 25 Oct match loopk's records exactly.
The settings loopk infers match the phone's preferences except max basal
(not binding), the carbs-required threshold (only a notification) and the
two high-temp-target settings, which changed on 23 Oct and are entered in
`loop_settings`. Replays with the phone's preferences
(`scripts/oref-replay.js --settings prefs.xml`) give the same results as
with the inferred settings.

The known gaps:

- **Autosens isn't rebuilt exactly.** The replay and the simulator use the
  sensitivity ratio AAPS recorded at each run. A changed algorithm rebuilds
  its own.
- **The ISF AAPS uses for carbs** with Dynamic ISF and AutoISF is a 24-hour
  average of a cache of past ISFs. AAPS clears that cache at 1,000 entries
  and reloads only one day after a restart, which loopk can't see.
- **Dynamic ISF's TDD ratio** differs by about 2% now and then.
- **The AAPS version.** The port follows 3.4.2.6; runs of older versions
  (3.3 until April 2026) match less often.
- **Late-entered carbs** count from when AAPS knew of them: the upload time
  when the phone was otherwise uploading promptly.

**One decision (phase 3)** rebuilds the run and decides three ways:
recorded, loopk unchanged, and changed. `reproduces` says whether loopk
unchanged matches AAPS for that run.

**A period (phase 4)** follows the design below, with these choices:

- The loop decides at the recorded run times, on the simulated glucose,
  IOB and COB.
- Simulated glucose = actual glucose − Σ k × ISF at 100% × (insulin
  difference − what is left of it as IOB), clipped to the sensor's 39–401
  mg/dL. The default k is 0.45. The band repeats the simulation at k ± 0.15.
- The simulation restarts from reality every 6 hours.
- Misses are found again in the simulated glucose and compared with the
  actual ones.

Checked on the day to 25 Oct 09:00 UTC, unchanged, at k = 0.45. *TIR*: %
of readings in 70–180 mg/dL, higher is better. *Mean*: mean glucose in
mg/dL. *Insulin*: units delivered. *SMB*: units given as SMBs. In both
rows, closer to actual is better.

| | TIR (%) | Mean (mg/dL) | Insulin (U) | SMB (U) |
|---|---|---|---|---|
| Actual | 81.5 | 124 | 42.9 | 28.0 |
| Simulated, unchanged | 81.5 | 124 | 42.9 | 28.4 |

The ISF-for-carbs cache needs the runs of the 58 hours before a rebuild:
34 h of readings, each averaging the 24 h before it. With only 26 h, COB
drifted by up to 6 g and the unchanged day reached a TIR of only 74.6%.

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
- **`src/oref/inputs.js`:** rebuilds the inputs AAPS had, from loopk's
  entries, treatments and profiles.
- **`src/oref/simulate.js`, `period.js`:** run the loop forward with
  changed settings, with a pump model (bolus step, basal rounding, SMB
  interval) and a body model.

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
