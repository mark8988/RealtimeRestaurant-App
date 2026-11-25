import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:record/record.dart';

import 'silero_vad_model.dart';
import 'turn_detector.dart';

class KioskVoice {
  final _recorder = AudioRecorder();
  final _device = const MethodChannel('restaurant/device');
  SileroVadModel? _model;
  Future<void>? _stopping;
  Future<Uint8List?>? _capture;
  StreamIterator<TurnEvent>? _events;
  bool _cancelled = false;

  Future<Uint8List?> listen(void Function() onSpeech) async {
    if (_capture != null) return null;
    _cancelled = false;
    final task = _listen(onSpeech);
    _capture = task;
    try {
      return await task;
    } finally {
      _capture = null;
    }
  }

  Future<Uint8List?> _listen(void Function() onSpeech) async {
    if (!await _recorder.hasPermission()) {
      throw const MicrophoneUnavailable();
    }
    if (_cancelled) return null;
    final model = _model ??= await SileroVadModel.load();
    if (_cancelled) return null;
    final audio = await _recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: 16000,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
      ),
    );
    final iterator = StreamIterator(VadTurnDetector(model).events(audio));
    _events = iterator;
    final until = DateTime.now().add(const Duration(seconds: 60));
    try {
      while (!_cancelled) {
        final remaining = until.difference(DateTime.now());
        if (remaining <= Duration.zero ||
            !await iterator.moveNext().timeout(
              remaining,
              onTimeout: () => false,
            )) {
          return null;
        }
        switch (iterator.current) {
          case SpeechStarted():
            onSpeech();
          case UtteranceCompleted(:final pcm):
            return pcm;
        }
      }
      return null;
    } finally {
      // Stop the producer before cancelling an iterator waiting for more data.
      try {
        await _stopRecorder();
      } finally {
        await iterator.cancel();
        _events = null;
      }
    }
  }

  Future<void> _stopRecorder() async {
    if (_stopping case final pending?) return pending;
    final task = _recorder.stop().then<void>((_) {});
    _stopping = task;
    try {
      await task;
    } finally {
      _stopping = null;
    }
  }

  Future<void> stop() async {
    _cancelled = true;
    final events = _events;
    try {
      if (events != null) {
        try {
          await _stopRecorder();
        } finally {
          await events.cancel();
        }
      }
    } finally {
      await _device.invokeMethod<void>('stopPlayback');
    }
  }

  Future<void> play(Uint8List audio) =>
      _device.invokeMethod<void>('play', {'audio': audio});

  Future<String?> readMenu() => _device.invokeMethod<String>('readMenu');

  Future<void> saveMenu(String json) =>
      _device.invokeMethod<void>('saveMenu', {'json': json});

  Future<void> dispose() async {
    try {
      await stop();
      await _capture;
    } catch (_) {
      // A cancelled platform operation can fail when Android closes the app.
    } finally {
      _model?.release();
      await _recorder.dispose();
    }
  }
}

class MicrophoneUnavailable implements Exception {
  const MicrophoneUnavailable();
}
