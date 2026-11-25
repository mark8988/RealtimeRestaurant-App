import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

enum HostRole {
  host('迎賓小幫手'),
  chef('廚房主廚');

  const HostRole(this.label);
  final String label;
}

class MenuItem {
  MenuItem.fromJson(Map<String, Object?> json)
    : id = json['id'] as String,
      name = json['name'] as String,
      category = json['category'] as String,
      description = json['description'] as String,
      price = json['price'] as int,
      available = json['available'] as bool;

  final String id;
  final String name;
  final String category;
  final String description;
  final int price;
  final bool available;
}

class MenuSnapshot {
  MenuSnapshot.decode(String encoded)
    : this.fromJson(jsonDecode(encoded) as Map<String, Object?>);

  MenuSnapshot.fromJson(Map<String, Object?> json)
    : version = json['version'] as int,
      items = [
        for (final raw in json['items'] as List)
          MenuItem.fromJson(raw as Map<String, Object?>),
      ];

  final int version;
  final List<MenuItem> items;
}

class TurnReply {
  TurnReply.fromJson(Map<String, Object?> json)
    : text = json['reply'] as String,
      itemId = json['itemId'] as String?,
      audioUnavailable = json['audioUnavailable'] == true,
      transcript = json['transcript'] as String?,
      audio = json['audioBase64'] != null
          ? base64Decode(json['audioBase64'] as String)
          : null;

  final String text;
  final String? transcript;
  final String? itemId;
  final bool audioUnavailable;
  final Uint8List? audio;
}

class ServiceException implements Exception {
  const ServiceException(this.status);
  final int status;
}

class RestaurantApi {
  RestaurantApi(this.endpoint, this.deviceToken);

  final Uri endpoint;
  final String deviceToken;
  final _menuHttp = _newClient();
  HttpClient _turnHttp = _newClient();

  static HttpClient _newClient() =>
      HttpClient()..connectionTimeout = const Duration(seconds: 8);

  Future<String> _request(String route, [Map<String, Object?>? body]) async {
    final client = body == null ? _menuHttp : _turnHttp;
    final pending = await client.openUrl(
      body == null ? 'GET' : 'POST',
      endpoint.resolve(route),
    );
    pending.followRedirects = false;
    if (deviceToken.isNotEmpty) {
      pending.headers.set(
        HttpHeaders.authorizationHeader,
        'Bearer $deviceToken',
      );
    }
    if (body != null) {
      pending.headers.contentType = ContentType.json;
      pending.write(jsonEncode(body));
    }
    final response = await pending.close().timeout(
      Duration(seconds: body == null ? 12 : 180),
      onTimeout: () {
        pending.abort();
        throw TimeoutException('Restaurant service timed out');
      },
    );
    if (response.statusCode != HttpStatus.ok) {
      pending.abort();
      throw ServiceException(response.statusCode);
    }
    final content = BytesBuilder(copy: false);
    await for (final chunk in response.timeout(const Duration(seconds: 15))) {
      content.add(chunk);
      if (content.length > 6 * 1024 * 1024) {
        pending.abort();
        throw const FormatException('Restaurant response too large');
      }
    }
    return utf8.decode(content.takeBytes());
  }

  Future<String> fetchMenu() => _request('api/menu');

  Future<TurnReply> ask({
    required HostRole role,
    required String? previousItemId,
    String? text,
    Uint8List? audio,
  }) async {
    if ((text == null) == (audio == null)) {
      throw ArgumentError('Supply text or audio');
    }
    final result = await _request(audio == null ? 'api/chat' : 'api/voice', {
      'role': role.name,
      if (previousItemId != null) 'previousItemId': previousItemId,
      if (text != null) 'message': text,
      if (audio != null) 'audioBase64': base64Encode(pcmToWave(audio)),
    });
    return TurnReply.fromJson(jsonDecode(result) as Map<String, Object?>);
  }

  void cancelTurn() {
    _turnHttp.close(force: true);
    _turnHttp = _newClient();
  }

  void close() {
    _menuHttp.close(force: true);
    _turnHttp.close(force: true);
  }
}

Uint8List pcmToWave(Uint8List pcm) {
  if (pcm.isEmpty || pcm.length.isOdd) {
    throw const FormatException('Invalid PCM16 frame length');
  }
  final wav = Uint8List(44 + pcm.length);
  final header = ByteData.sublistView(wav, 0, 44);
  for (final (offset, tag) in [(0, 'RIFF'), (8, 'WAVEfmt '), (36, 'data')]) {
    wav.setRange(offset, offset + tag.length, tag.codeUnits);
  }
  header
    ..setUint32(4, wav.length - 8, Endian.little)
    ..setUint32(16, 16, Endian.little)
    ..setUint16(20, 1, Endian.little)
    ..setUint16(22, 1, Endian.little)
    ..setUint32(24, 16000, Endian.little)
    ..setUint32(28, 32000, Endian.little)
    ..setUint16(32, 2, Endian.little)
    ..setUint16(34, 16, Endian.little)
    ..setUint32(40, pcm.length, Endian.little);
  wav.setRange(44, wav.length, pcm);
  return wav;
}
