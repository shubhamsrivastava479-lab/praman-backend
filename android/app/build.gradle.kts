plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.praman.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.praman.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "3.0"
    }

    buildFeatures { buildConfig = true }

    // Two apps from one code base:
    //   business  "Praman Business"     team login (vendor, agent, insurer, viewer, admin)
    //   consumer  "SatyaSakshi Praman"  B2C checks + "join my verification call" + call links from WhatsApp
    flavorDimensions += "audience"
    productFlavors {
        create("business") {
            dimension = "audience"
            applicationId = "com.praman.app"
            resValue("string", "app_name", "Praman Business")
            buildConfigField("String", "START_PATH", "\"/login.html\"")
            buildConfigField("String", "APP_TAG", "\"PramanApp/2 PramanBusiness\"")
        }
        create("consumer") {
            dimension = "audience"
            applicationId = "com.satyasakshi.praman"
            resValue("string", "app_name", "SatyaSakshi Praman")
            buildConfigField("String", "START_PATH", "\"/c/\"")
            buildConfigField("String", "APP_TAG", "\"PramanApp/2 PramanConsumer\"")
        }
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
