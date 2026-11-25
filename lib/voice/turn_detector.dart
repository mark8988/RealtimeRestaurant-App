import 'dart:collection';
import 'dart:typed_data';

const _sampleRate = 16000;

sealed class TurnEvent {
  const TurnEvent();
}

/// 已確認使用者開口（達最短發話長度），語音插話以此打斷 TTS
class SpeechStarted extends TurnEvent {
  const SpeechStarted();
}

/// 一句說完，`pcm` 為含 pre-roll 的 16kHz mono 16-bit PCM
class UtteranceCompleted extends TurnEvent {
  const UtteranceCompleted(this.pcm);

  final Uint8List pcm;
}

/// 單幀人聲機率（Silero VAD 等），實作抽換不影響斷句邏輯
abstract class SpeechProbabilityModel {
  int get frameSamples;

  double probability(Int16List frame);

  /// 開始新一段收音前清除模型內部狀態
  void reset();
}

class TurnDetectorConfig {
  const TurnDetectorConfig({
    this.speechThreshold = 0.5,
    this.playbackSpeechThreshold = 0.8,
    this.hysteresis = 0.15,
    this.minSpeech = const Duration(milliseconds: 500),
    this.playbackMinSpeech = const Duration(milliseconds: 800),
    this.endSilence = const Duration(milliseconds: 500),
    this.preRoll = const Duration(milliseconds: 300),
    this.maxUtterance = const Duration(seconds: 28),
  });

  final double speechThreshold;
  final double playbackSpeechThreshold;
  final double hysteresis;
  final Duration minSpeech;
  final Duration playbackMinSpeech;
  final Duration endSilence;
  final Duration preRoll;
  final Duration maxUtterance;
}

abstract class TurnDetector {
  Stream<TurnEvent> events(Stream<Uint8List> pcm16kMono);

  set playbackActive(bool value);
}

class VadTurnDetector implements TurnDetector {
  VadTurnDetector(this._model, {this.config = const TurnDetectorConfig()});

  final SpeechProbabilityModel _model;
  final TurnDetectorConfig config;
  bool _playbackActive = false;

  @override
  set playbackActive(bool value) => _playbackActive = value;

  @override
  Stream<TurnEvent> events(Stream<Uint8List> pcm16kMono) async* {
    _model.reset();
    final frameBytes = _model.frameSamples * 2;
    final frameMs = _model.frameSamples * 1000 / _sampleRate;
    final preRollFrames = (config.preRoll.inMilliseconds / frameMs).ceil();
    final preRoll = ListQueue<Uint8List>();
    final pending = BytesBuilder(copy: false);
    BytesBuilder? utterance;
    var started = false;
    var speechMs = 0.0;
    var silenceMs = 0.0;
    var totalMs = 0.0;

    await for (final chunk in pcm16kMono) {
      pending.add(chunk);
      if (pending.length < frameBytes) continue;
      final buffered = pending.takeBytes();
      var offset = 0;
      for (; offset + frameBytes <= buffered.length; offset += frameBytes) {
        final frame = Uint8List.fromList(
          buffered.sublist(offset, offset + frameBytes),
        );
        final probability = _model.probability(frame.buffer.asInt16List());
        final threshold = _playbackActive
            ? config.playbackSpeechThreshold
            : config.speechThreshold;

        final current = utterance;
        if (current == null) {
          if (probability >= threshold) {
            utterance = BytesBuilder(copy: false)
              ..add(Uint8List.fromList([for (final f in preRoll) ...f]))
              ..add(frame);
            totalMs = frameMs * (preRoll.length + 1);
            speechMs = frameMs;
            silenceMs = 0;
            started = false;
            preRoll.clear();
          } else {
            preRoll.add(frame);
            if (preRoll.length > preRollFrames) preRoll.removeFirst();
          }
        } else {
          current.add(frame);
          totalMs += frameMs;
          if (probability >= threshold) speechMs += frameMs;
          silenceMs = probability >= threshold - config.hysteresis
              ? 0
              : silenceMs + frameMs;
        }

        final active = utterance;
        if (active == null) continue;
        final minSpeech = _playbackActive
            ? config.playbackMinSpeech
            : config.minSpeech;
        if (!started && speechMs >= minSpeech.inMilliseconds) {
          started = true;
          yield const SpeechStarted();
        }
        if (silenceMs >= config.endSilence.inMilliseconds ||
            totalMs >= config.maxUtterance.inMilliseconds) {
          if (started) yield UtteranceCompleted(active.takeBytes());
          utterance = null;
        }
      }
      pending.add(buffered.sublist(offset));
    }
  }
}
