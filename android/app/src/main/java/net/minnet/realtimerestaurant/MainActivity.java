package net.minnet.realtimerestaurant;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.MethodChannel;

public final class MainActivity extends FlutterActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = () -> finishPlayback("語音播放逾時");
    private MediaPlayer player;
    private File audioFile;
    private MethodChannel.Result playback;

    @Override
    public void configureFlutterEngine(FlutterEngine engine) {
        super.configureFlutterEngine(engine);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        new MethodChannel(engine.getDartExecutor().getBinaryMessenger(), "restaurant/device")
            .setMethodCallHandler((call, result) -> {
                switch (call.method) {
                    case "play": play(call.argument("audio"), result); break;
                    case "stopPlayback": finishPlayback(null); result.success(null); break;
                    case "readMenu": result.success(getPreferences(MODE_PRIVATE).getString("menu", null)); break;
                    case "saveMenu":
                        getPreferences(MODE_PRIVATE).edit().putString("menu", call.argument("json")).apply();
                        result.success(null);
                        break;
                    default: result.notImplemented();
                }
            });
    }

    private void play(byte[] audio, MethodChannel.Result result) {
        if (audio == null || audio.length == 0 || audio.length > 4000000) {
            result.error("PLAYBACK_FAILED", "無效的語音回覆", null);
            return;
        }
        finishPlayback(null);
        playback = result;
        try {
            audioFile = File.createTempFile("reply-", ".audio", getCacheDir());
            try (FileOutputStream output = new FileOutputStream(audioFile)) {
                output.write(audio);
            }
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            player.setDataSource(audioFile.getAbsolutePath());
            player.setOnPreparedListener(current -> {
                if (player == current) current.start();
            });
            player.setOnCompletionListener(current -> {
                if (player == current) finishPlayback(null);
            });
            player.setOnErrorListener((current, what, extra) -> {
                if (player == current) finishPlayback("無法播放伺服器回傳的音訊");
                return true;
            });
            handler.postDelayed(timeout, 40000);
            player.prepareAsync();
        } catch (IOException | RuntimeException error) {
            finishPlayback("無法載入語音回覆");
        }
    }

    private void finishPlayback(String error) {
        handler.removeCallbacks(timeout);
        if (player != null) {
            player.release();
            player = null;
        }
        if (audioFile != null) {
            audioFile.delete();
            audioFile = null;
        }
        MethodChannel.Result result = playback;
        playback = null;
        if (result == null) return;
        if (error == null) result.success(null);
        else result.error("PLAYBACK_FAILED", error, null);
    }

    @Override protected void onPause() {
        finishPlayback(null);
        super.onPause();
    }

    @Override protected void onDestroy() {
        finishPlayback(null);
        super.onDestroy();
    }
}
