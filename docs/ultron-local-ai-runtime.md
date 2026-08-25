# Eclipse Ultron Local AI Runtime

## Назначение

`Eclipse AI Runtime` — локальный и переносимый контур для голоса и экспериментальных
моделей Eclipse Ultron. Он не устанавливает Windows Speech Capability и не размещает
исполняемые файлы или веса моделей на системном диске.

Утверждённый каталог этой рабочей станции:

```text
E:\ADMIN_HOPSON_PC\Программы\Eclipse AI Runtime
```

## Состав

| Компонент | Версия / модель | Назначение | Источник |
| --- | --- | --- | --- |
| whisper.cpp | release `b4938`, CUDA 12.4 | offline STT | `ggml-org/whisper.cpp` |
| Whisper | `large-v3-turbo-q5_0` | русское распознавание речи | `ggerganov/whisper.cpp` |
| Ollama | `0.32.15`, portable Windows amd64 | локальный model server | `ollama/ollama` |
| HuiHui Qwen3.8 | `27b`, Q4_K_M | изолированный Lab-чат | `huihui_ai/qwen3.8-abliterated:27b` |

Проверенные SHA-256:

```text
whisper-cublas-12.4.0-bin-x64.zip
c1b17166e1e31a91cc8e9c1f910d3785e3ce757bb2958bf9dce13fdb4880005f

ggml-large-v3-turbo-q5_0.bin
394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2

ollama-windows-amd64.zip
a1d11d46a944f9c7521f5e9a3a5db51cd3365401da627d96c204698fc6914ff9
```

Digest архивов получен из официальных GitHub Releases. Digest Whisper-модели получен
из LFS metadata официального Hugging Face repository. Ollama дополнительно выполнила
собственную SHA-256 verification каждого model blob перед записью manifest.

## Каталоги

```text
Eclipse AI Runtime\
├── downloads\             # проверенные portable archives
├── models\
│   ├── ollama\            # 27B model store, около 16.52 GiB
│   └── whisper\           # STT model, около 548 MiB
├── ollama\                # portable Ollama runtime
├── temp\                  # только технические runtime logs
└── whisper\Release\       # CUDA whisper.cpp binaries
```

Речь и транскрипт обрабатываются в памяти. Ultron не включает `--save-audio`, не создаёт
WAV-файлы и не пишет распознанный текст в runtime logs. Electron renderer передаёт в IPC
только пустой one-shot запрос; путь, модель и параметры задаёт доверенный main process.

## Как пользоваться голосом

1. Открыть `Ultron Core` или `Чат`.
2. Нажать `Сказать команду` или кнопку микрофона.
3. Говорить обычным голосом после появления состояния `Слушаю`.
4. Проверить распознанный текст. В чате текст только заполняет поле и не отправляется
   автоматически.
5. При ошибке ручной ввод остаётся доступным.

Один voice-сеанс ограничен 12 секундами. Одновременно разрешён только один STT process,
действуют rate limit, общий process timeout и ограничение JSON-ответа. Фоновая запись и
wake word отсутствуют.

На Windows capture-процесс фиксирует SDL backend `directsound`. Это обходит подтверждённую
несовместимость стандартного WASAPI backend с USB-микрофоном FIFINE и согласует требуемый
Whisper-формат `16 kHz / mono`, не меняя системные настройки устройства.

## Local model profiles

| Профиль | Endpoint | Полномочия |
| --- | --- | --- |
| Primary | `127.0.0.1:11434` | обычный локальный чат |
| Ultron Lab | `127.0.0.1:11435` | только chat completion, без tools |

Portable Lab server запускается только на loopback. Он использует model store на `E:` и
не слушает LAN. Сам server может запускаться вместе с Ultron, но 27B-модель загружается
только после явного выбора Lab-профиля и первого сообщения.

HuiHui Qwen3.8 abliterated не является доверенным planner или policy engine. Ей не
передаются shell, filesystem, network tools, secrets, MCP, install, deploy или operator
execute. Результаты требуют ручной проверки. Снятие model-level отказов не ослабляет
детерминированный Policy Gate Eclipse Ultron.

## Hardware contract этой рабочей станции

- GPU: RTX 4060 Ti 16 GiB;
- RAM: 64 GiB;
- фактический model file: 15.65 GiB Q4_K_M;
- план размещения Ollama: примерно 11.3 GiB GPU + 4.7 GiB host memory;
- рабочий context для pilot: 8K, а не рекламные 262K;
- `OLLAMA_LOAD_TIMEOUT=15m` для первого чтения модели с диска E:;
- `OLLAMA_KEEP_ALIVE=5m`, чтобы не удерживать 27B-модель постоянно.

Измеренный pilot с `num_ctx=8192`, `think=false`, `num_predict<=64`:

| Режим | Load | Generation | Total |
| --- | ---: | ---: | ---: |
| cold start | 233.3 сек | 8.2 ток/с | 254.56 сек |
| warm request | 0 сек | 6.98 ток/с | 5.07 сек |

Вывод: модель технически работает на текущем железе, но почти четырёхминутный cold start
исключает её из default-профиля. Она остаётся явным Lab-выбором для длинной исследовательской
сессии. Для ежедневного интерактивного чата основной `qwen3:8b` существенно практичнее.

## Security и ограничения

- никаких OAuth, облачной передачи аудио или standing authorisations;
- никакого автоматического выбора abliterated модели по умолчанию;
- endpoint фиксирован на loopback и отдельно разрешён в CSP;
- model output считается недоверенным текстом;
- runtime archives и модельные веса не включаются в Git или installer;
- публикация installer остаётся заблокированной до signing и provenance review.

## Rollback

Удаление только Lab-модели выполняется portable Ollama с теми же `OLLAMA_HOST` и
`OLLAMA_MODELS`, после чего UI возвращается на `Qwen 3 8B`.

Полный rollback требует закрыть Eclipse Ultron, остановить только process, который слушает
`127.0.0.1:11435`, и удалить точный каталог `Eclipse AI Runtime`. Каталоги Eclipse Ultron,
репозитории, primary Ollama и данные пользователя при этом не затрагиваются.
