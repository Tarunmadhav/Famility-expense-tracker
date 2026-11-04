plugins {
    id("com.android.application")
}

val plannerVersionCode = providers.gradleProperty("versionCode").get().toInt()
val plannerVersionName = providers.gradleProperty("versionName").get()
val plannerApiBaseUrl = providers.gradleProperty("plannerApiBaseUrl")
    .getOrElse("https://family-finance-planner.tarungudipatimadhav.workers.dev/")

val signingVariables = listOf(
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
)

android {
    namespace = "com.family.planner"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.family.planner"
        minSdk = 26
        targetSdk = 35
        versionCode = plannerVersionCode
        versionName = plannerVersionName
        buildConfigField("String", "PLANNER_URL", "\"$plannerApiBaseUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            val path = System.getenv("ANDROID_KEYSTORE_PATH")
            val storePass = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            val keyAliasValue = System.getenv("ANDROID_KEY_ALIAS")
            val keyPass = System.getenv("ANDROID_KEY_PASSWORD")
            if (!path.isNullOrBlank() && !storePass.isNullOrBlank() &&
                !keyAliasValue.isNullOrBlank() && !keyPass.isNullOrBlank()
            ) {
                storeFile = file(path)
                storePassword = storePass
                keyAlias = keyAliasValue
                keyPassword = keyPass
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

/**
 * Release builds must be signed with the owner's keystore. If any of the four
 * variables is missing we stop with an explicit message instead of silently
 * producing an unsigned APK or falling back to the debug key.
 */
val requireReleaseSigning = tasks.register("requireReleaseSigning") {
    doLast {
        val missing = signingVariables.filter { System.getenv(it).isNullOrBlank() }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Release signing is not configured. Missing environment variables: " +
                    missing.joinToString(", ") +
                    ". See android/SIGNING.md for the keytool and GitHub secret steps."
            )
        }
        val keystore = File(System.getenv("ANDROID_KEYSTORE_PATH"))
        if (!keystore.isFile) {
            throw GradleException("ANDROID_KEYSTORE_PATH does not point to a file: ${keystore.absolutePath}")
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(requireReleaseSigning)
}
