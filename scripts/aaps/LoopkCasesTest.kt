package app.aaps.plugins.aps

import app.aaps.core.data.model.GlucoseUnit
import app.aaps.core.interfaces.aps.AutosensResult
import app.aaps.core.interfaces.aps.CurrentTemp
import app.aaps.core.interfaces.aps.GlucoseStatusAutoIsf
import app.aaps.core.interfaces.aps.GlucoseStatusSMB
import app.aaps.core.interfaces.aps.IobTotal
import app.aaps.core.interfaces.aps.MealData
import app.aaps.core.interfaces.aps.OapsProfile
import app.aaps.core.interfaces.aps.OapsProfileAutoIsf
import app.aaps.core.interfaces.aps.RT
import app.aaps.core.keys.StringKey
import app.aaps.plugins.aps.openAPSAutoISF.DetermineBasalAutoISF
import app.aaps.plugins.aps.openAPSSMB.DetermineBasalSMB
import app.aaps.shared.tests.TestBaseWithProfile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.mockito.kotlin.whenever
import java.io.File

/**
 * Runs AAPS's determine_basal on the synthetic cases loopk generates
 * (loopk: scripts/oref-cases.js) and writes AAPS's results, for loopk to
 * compare with its port. Skipped unless LOOPK_CASES is set:
 *
 *   LOOPK_CASES=cases.jsonl LOOPK_RESULTS=results.jsonl TZ=UTC \
 *     ./gradlew :plugins:aps:testFullDebugUnitTest --tests app.aaps.plugins.aps.LoopkCasesTest
 */
class LoopkCasesTest : TestBaseWithProfile() {

    private val json = Json { ignoreUnknownKeys = true; allowSpecialFloatingPointValues = true }

    @Test
    fun runCases() {
        val casesFile = System.getenv("LOOPK_CASES")
        assumeTrue(casesFile != null, "LOOPK_CASES not set")
        val resultsFile = File(System.getenv("LOOPK_RESULTS") ?: "$casesFile.results")
        val smb = DetermineBasalSMB(profileUtil, fabricPrivacy)
        val autoIsf = DetermineBasalAutoISF(profileUtil)
        resultsFile.printWriter().use { out ->
            File(casesFile).forEachLine { line ->
                if (line.isBlank()) return@forEachLine
                val c = json.parseToJsonElement(line).jsonObject
                val id = c["id"]!!.jsonPrimitive.content
                val result = try {
                    json.encodeToString(RT.serializer(), run(c, smb, autoIsf))
                } catch (e: Exception) {
                    json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(e.toString()))
                        .let { """{"error":$it}""" }
                }
                out.println("""{"id":${json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(id))},"result":$result}""")
            }
        }
    }

    private fun run(c: JsonObject, smb: DetermineBasalSMB, autoIsf: DetermineBasalAutoISF): RT {
        val algorithm = c["algorithm"]!!.jsonPrimitive.content
        val units = c["profile"]!!.jsonObject["out_units"]!!.jsonPrimitive.content
        whenever(preferences.get(StringKey.GeneralUnits)).thenReturn(if (units == "mmol/L") GlucoseUnit.MMOL.asText else GlucoseUnit.MGDL.asText)
        val currentTemp = json.decodeFromJsonElement<CurrentTemp>(c["currentTemp"]!!)
        val iob = json.decodeFromJsonElement<List<IobTotal>>(c["iob"]!!).toTypedArray()
        val autosens = json.decodeFromJsonElement<AutosensResult>(c["autosens"]!!)
        val meal = json.decodeFromJsonElement<MealData>(c["meal"]!!)
        val microBolusAllowed = c["microBolusAllowed"]!!.jsonPrimitive.boolean
        val currentTime = c["currentTime"]!!.jsonPrimitive.long
        val flatBGsDetected = c["flatBGsDetected"]!!.jsonPrimitive.boolean
        return if (algorithm == "AUTO_ISF") {
            val profile = json.decodeFromJsonElement<OapsProfileAutoIsf>(c["profile"]!!)
            val extra = c["autoIsf"]!!.jsonObject
            autoIsf.determine_basal(
                glucose_status = json.decodeFromJsonElement<GlucoseStatusAutoIsf>(c["glucoseStatus"]!!),
                currenttemp = currentTemp, iob_data_array = iob, profile = profile, autosens_data = autosens, meal_data = meal,
                microBolusAllowed = microBolusAllowed, currentTime = currentTime, flatBGsDetected = flatBGsDetected,
                autoIsfMode = true, loop_wanted_smb = extra["loop_wanted_smb"]!!.jsonPrimitive.content,
                profile_percentage = profile.profile_percentage, smb_ratio = extra["smb_ratio"]!!.jsonPrimitive.content.toDouble(),
                smb_max_range_extension = profile.smb_max_range_extension, iob_threshold_percent = extra["iob_threshold_percent"]!!.jsonPrimitive.int,
                auto_isf_consoleError = mutableListOf(), auto_isf_consoleLog = mutableListOf()
            )
        } else {
            smb.determine_basal(
                glucose_status = json.decodeFromJsonElement<GlucoseStatusSMB>(c["glucoseStatus"]!!),
                currenttemp = currentTemp, iob_data_array = iob, profile = json.decodeFromJsonElement<OapsProfile>(c["profile"]!!),
                autosens_data = autosens, meal_data = meal, microBolusAllowed = microBolusAllowed, currentTime = currentTime,
                flatBGsDetected = flatBGsDetected, dynIsfMode = algorithm == "DYN_ISF"
            )
        }
    }
}
