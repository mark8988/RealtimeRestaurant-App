allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val sharedBuildDirectory = rootProject.layout.buildDirectory.dir("../../build").get()
rootProject.layout.buildDirectory.set(sharedBuildDirectory)
subprojects {
    layout.buildDirectory.set(sharedBuildDirectory.dir(name))
    evaluationDependsOn(":app")

    val alignCompileSdk = {
        extensions.findByType<com.android.build.gradle.LibraryExtension>()?.compileSdk = 37
    }
    if (state.executed) alignCompileSdk() else afterEvaluate { alignCompileSdk() }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
