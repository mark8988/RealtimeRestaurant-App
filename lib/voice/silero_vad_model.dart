import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:onnxruntime_v2/onnxruntime_v2.dart';

import 'turn_detector.dart';

const sileroVadAssetPath = 'assets/models/silero_vad/silero_vad.onnx';

/// Silero VAD（v5/v6，16kHz）：每幀 512 樣本，前接上一幀最後 64 樣本作為 context
class SileroVadModel implements SpeechProbabilityModel {
  SileroVadModel._(this._session);

  static Future<SileroVadModel> load() async {
    OrtEnv.instance.init();
    final bytes = (await rootBundle.load(sileroVadAssetPath)).buffer
        .asUint8List();
    final options = OrtSessionOptions()
      ..setInterOpNumThreads(1)
      ..setIntraOpNumThreads(1);
    final session = OrtSession.fromBuffer(bytes, options);
    options.release();
    return SileroVadModel._(session);
  }

  static const _contextSamples = 64;
  static const _stateSize = 2 * 1 * 128;

  final OrtSession _session;
  final _runOptions = OrtRunOptions();
  final _context = Float32List(_contextSamples);
  Float32List _state = Float32List(_stateSize);

  @override
  int get frameSamples => 512;

  @override
  void reset() {
    _context.fillRange(0, _contextSamples, 0);
    _state = Float32List(_stateSize);
  }

  @override
  double probability(Int16List frame) {
    final input = Float32List(_contextSamples + frameSamples)
      ..setRange(0, _contextSamples, _context);
    for (var i = 0; i < frameSamples; i++) {
      input[_contextSamples + i] = frame[i] / 32768;
    }
    _context.setRange(0, _contextSamples, input, frameSamples);

    final tensors = {
      'input': OrtValueTensor.createTensorWithDataList(
        [input],
        [1, input.length],
      ),
      'state': OrtValueTensor.createTensorWithDataList([_state], [2, 1, 128]),
      'sr': OrtValueTensor.createTensorWithDataList([
        Int64List.fromList([16000]),
      ], []),
    };
    final outputs = _session.run(_runOptions, tensors);
    try {
      final probability = _doubles(outputs[0]!.value).single;
      _state = Float32List.fromList(_doubles(outputs[1]!.value).toList());
      return probability;
    } finally {
      for (final tensor in tensors.values) {
        tensor.release();
      }
      for (final output in outputs) {
        output?.release();
      }
    }
  }

  void release() {
    _runOptions.release();
    _session.release();
  }
}

// ORT 輸出為巢狀 List（如 [[p]]、[2][1][128]），攤平成一維
Iterable<double> _doubles(Object? value) sync* {
  if (value is num) {
    yield value.toDouble();
  } else if (value is Iterable) {
    for (final element in value) {
      yield* _doubles(element);
    }
  }
}
