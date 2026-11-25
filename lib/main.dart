import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'restaurant_api.dart';
import 'voice/kiosk_voice.dart';

const _background = Color(0xfff7f2e8);
const _ink = Color(0xff193a30);
const _accent = Color(0xffa6432d);
const _paper = Color(0xfffffcf6);
const _apiUrl = String.fromEnvironment('RESTAURANT_API_URL');
const _deviceToken = String.fromEnvironment('RESTAURANT_DEVICE_TOKEN');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final endpoint = Uri.tryParse(
    _apiUrl.isEmpty && kDebugMode ? 'http://10.0.2.2:8787/' : _apiUrl,
  );
  final usable =
      endpoint != null &&
      endpoint.hasAuthority &&
      endpoint.host.isNotEmpty &&
      endpoint.userInfo.isEmpty &&
      !endpoint.hasQuery &&
      !endpoint.hasFragment &&
      (endpoint.scheme == 'https' || (kDebugMode && endpoint.scheme == 'http'));
  runApp(
    RestaurantApp(
      api: usable
          ? RestaurantApi(
              endpoint.replace(
                path: endpoint.path.endsWith('/')
                    ? endpoint.path
                    : '${endpoint.path}/',
              ),
              _deviceToken,
            )
          : null,
    ),
  );
}

class RestaurantApp extends StatelessWidget {
  const RestaurantApp({super.key, required this.api});

  final RestaurantApi? api;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    title: '門口菜單助手',
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: _ink),
      scaffoldBackgroundColor: _background,
      useMaterial3: true,
    ),
    home: _Kiosk(api: api),
  );
}

class _Kiosk extends StatefulWidget {
  const _Kiosk({required this.api});
  final RestaurantApi? api;

  @override
  State<_Kiosk> createState() => _KioskState();
}

class _KioskState extends State<_Kiosk> with WidgetsBindingObserver {
  final _voice = KioskVoice();
  final _input = TextEditingController();
  Timer? _refreshTimer;
  MenuSnapshot? _menu;
  HostRole _role = HostRole.host;
  bool _online = false;
  bool _refreshing = false;
  bool _voiceLoop = false;
  bool _listenEnabled = false;
  bool _typingTurn = false;
  int _session = 0;
  String? _lastItem;
  String? _question;
  String? _reply;
  String? _notice;
  String _stateLabel = '準備好回答您的餐點問題';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_initializeMenu());
  }

  Future<void> _initializeMenu() async {
    try {
      if (await _voice.readMenu() case final raw?) {
        final cached = MenuSnapshot.decode(raw);
        if (mounted) setState(() => _menu = cached);
      }
    } catch (_) {
      // Refresh from the server when a cache is missing or unreadable.
    }
    if (!mounted) return;
    unawaited(_refreshMenu());
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_refreshMenu()),
    );
  }

  Future<void> _refreshMenu() async {
    final api = widget.api;
    if (_refreshing || api == null) return;
    _refreshing = true;
    try {
      final raw = await api.fetchMenu();
      final next = MenuSnapshot.decode(raw);
      final changed = _menu?.version != next.version;
      if (mounted) {
        setState(() {
          _online = true;
          if (changed) _menu = next;
        });
      }
      if (changed) {
        try {
          await _voice.saveMenu(raw);
        } catch (_) {
          // The online menu remains usable when its local cache cannot be written.
        }
      }
    } catch (_) {
      if (mounted) setState(() => _online = false);
    } finally {
      _refreshing = false;
    }
  }

  bool _current(int session) => mounted && _session == session;

  Future<void> _ask(int session, {String? text, Uint8List? audio}) async {
    final api = widget.api;
    if (api == null) return;
    setState(() {
      _notice = null;
      _stateLabel = '正在查詢菜單…';
      if (text != null) _question = text;
      _reply = null;
    });
    try {
      final reply = await api.ask(
        role: _role,
        previousItemId: _lastItem,
        text: text,
        audio: audio,
      );
      if (!_current(session)) return;
      setState(() {
        _lastItem = reply.itemId;
        _question = reply.transcript ?? text;
        _reply = reply.text;
        if (reply.audioUnavailable) {
          _notice = '伺服器暫時無法朗讀，請查看文字回答。';
        }
        _stateLabel = reply.audio != null ? '正在播放回答…' : '已收到回答';
      });
      if (reply.audio case final responseAudio?) {
        try {
          await _voice.play(responseAudio);
        } catch (_) {
          if (_current(session)) {
            setState(() => _notice = '語音無法播放，請查看上方文字回答。');
          }
        }
      }
    } on ServiceException catch (error) {
      if (!_current(session)) return;
      if (error.status == 422 && audio != null) {
        setState(() => _notice = '沒有聽清楚，請再說一次。');
        return;
      }
      rethrow;
    }
  }

  Future<void> _startVoice() async {
    if (widget.api == null || _voiceLoop || _typingTurn) return;
    final session = _session;
    setState(() {
      _voiceLoop = true;
      _listenEnabled = true;
    });
    try {
      while (_current(session) && _listenEnabled) {
        setState(() => _stateLabel = '正在聆聽，請說話');
        final pcm = await _voice.listen(() {
          if (_current(session) && _listenEnabled) {
            setState(() => _stateLabel = '聽到您的聲音…');
          }
        });
        if (!_current(session) || !_listenEnabled || pcm == null) break;
        await _ask(session, audio: pcm);
      }
    } on MicrophoneUnavailable {
      if (_current(session)) {
        setState(() => _notice = '請允許麥克風存取，或使用文字提問。');
      }
    } catch (_) {
      if (_current(session)) {
        setState(() => _notice = '語音服務暫時無法使用。您仍可查看菜單。');
      }
    } finally {
      if (mounted) {
        setState(() {
          _voiceLoop = false;
          _listenEnabled = false;
          if (_current(session)) _stateLabel = '語音已暫停';
        });
      }
    }
  }

  void _stop({bool reset = false}) {
    setState(() {
      _session++;
      _listenEnabled = false;
      _stateLabel = '語音已暫停';
      if (reset) {
        _lastItem = null;
        _question = null;
        _reply = null;
        _notice = null;
        _input.clear();
      }
    });
    widget.api?.cancelTurn();
    unawaited(_stopAudio());
  }

  Future<void> _stopAudio() async {
    try {
      await _voice.stop();
    } catch (_) {
      // The platform can already have stopped audio when the activity pauses.
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _typingTurn || _voiceLoop || widget.api == null) return;
    final session = _session;
    setState(() {
      _typingTurn = true;
      _input.clear();
    });
    try {
      await _ask(session, text: text);
    } catch (_) {
      if (_current(session)) {
        setState(() => _notice = '對話服務暫時無法使用。您仍可查看菜單。');
      }
    } finally {
      if (mounted) {
        setState(() {
          _typingTurn = false;
          if (_current(session)) _stateLabel = '可以繼續提問';
        });
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      _stop(reset: true);
    }
    if (state == AppLifecycleState.resumed) unawaited(_refreshMenu());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    widget.api?.close();
    unawaited(_voice.dispose().catchError((Object _) {}));
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final canAsk = !_voiceLoop && !_typingTurn && widget.api != null;
    final menu = _menu;
    final connection = widget.api == null
        ? '尚未設定伺服器'
        : _online
        ? '菜單已連線 · 版本 ${menu?.version ?? '—'}'
        : menu == null
        ? '尚未載入菜單'
        : '離線菜單 · 版本 ${menu.version}';
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 900;
            final controls = _controls(canAsk);
            final menuPanel = _menuPanel(menu);
            return ListView(
              padding: EdgeInsets.all(wide ? 32 : 20),
              children: [
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 16,
                  runSpacing: 12,
                  children: [
                    const Text(
                      '門口菜單助手',
                      style: TextStyle(
                        color: _ink,
                        fontSize: 28,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(connection, style: const TextStyle(color: _ink)),
                        IconButton(
                          tooltip: '更新菜單',
                          onPressed: widget.api == null ? null : _refreshMenu,
                          icon: const Icon(Icons.refresh_rounded, color: _ink),
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 24),
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 5, child: controls),
                      const SizedBox(width: 28),
                      Expanded(flex: 4, child: menuPanel),
                    ],
                  )
                else ...[
                  controls,
                  const SizedBox(height: 24),
                  menuPanel,
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _controls(bool canAsk) => DecoratedBox(
    decoration: BoxDecoration(
      color: _ink,
      borderRadius: BorderRadius.circular(28),
    ),
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '今天想吃什麼？',
            style: TextStyle(
              color: Colors.white,
              fontSize: 39,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final role in HostRole.values)
                ChoiceChip(
                  label: Text(role.label),
                  selected: _role == role,
                  onSelected: canAsk
                      ? (_) => setState(() => _role = role)
                      : null,
                ),
            ],
          ),
          const SizedBox(height: 24),
          Semantics(
            liveRegion: true,
            child: Text(
              _stateLabel,
              style: const TextStyle(color: Color(0xffd5e8de), fontSize: 16),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton.icon(
                style: FilledButton.styleFrom(
                  backgroundColor: _accent,
                  foregroundColor: Colors.white,
                  minimumSize: const Size(140, 56),
                ),
                onPressed: _listenEnabled
                    ? () => _stop()
                    : canAsk
                    ? _startVoice
                    : null,
                icon: Icon(
                  _listenEnabled ? Icons.stop_rounded : Icons.mic_rounded,
                ),
                label: Text(_listenEnabled ? '停止語音' : '開始語音'),
              ),
              TextButton(
                style: TextButton.styleFrom(foregroundColor: Colors.white),
                onPressed: () => _stop(reset: true),
                child: const Text('新對話'),
              ),
            ],
          ),
          if (_question != null || _reply != null || _notice != null) ...[
            const SizedBox(height: 20),
            Semantics(
              liveRegion: true,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: _paper,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_question != null)
                        Text(
                          _question!,
                          style: const TextStyle(color: _accent),
                        ),
                      if (_reply != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 5),
                          child: Text(
                            _reply!,
                            style: const TextStyle(fontSize: 21, color: _ink),
                          ),
                        ),
                      if (_notice != null)
                        Text(_notice!, style: const TextStyle(color: _ink)),
                    ],
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 22),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _input,
                  enabled: canAsk,
                  maxLength: 300,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => unawaited(_send()),
                  decoration: InputDecoration(
                    hintText: '例如：有推薦的素食嗎？',
                    counterText: '',
                    filled: true,
                    fillColor: _paper,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
              IconButton(
                color: Colors.white,
                disabledColor: Colors.white38,
                tooltip: '送出文字問題',
                onPressed: canAsk ? _send : null,
                icon: const Icon(Icons.send_rounded),
              ),
            ],
          ),
        ],
      ),
    ),
  );

  Widget _menuPanel(MenuSnapshot? menu) {
    final categories = <String, List<MenuItem>>{};
    for (final item in menu?.items ?? const <MenuItem>[]) {
      categories.putIfAbsent(item.category, () => []).add(item);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '今日菜單',
          style: TextStyle(
            color: _ink,
            fontSize: 28,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 12),
        if (categories.isEmpty) Text(menu == null ? '等待店家發布菜單。' : '目前沒有已發布餐點。'),
        for (final entry in categories.entries) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text(
              entry.key,
              style: const TextStyle(
                color: _accent,
                fontWeight: FontWeight.w800,
                fontSize: 17,
              ),
            ),
          ),
          for (final item in entry.value)
            Card(
              color: _paper,
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                selected: _lastItem == item.id,
                title: Text(
                  item.name,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                subtitle: Text(item.description),
                trailing: Text(
                  item.available ? 'NT\$ ${item.price}' : '暫停售',
                  style: const TextStyle(
                    color: _ink,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 5,
                ),
              ),
            ),
        ],
      ],
    );
  }
}
