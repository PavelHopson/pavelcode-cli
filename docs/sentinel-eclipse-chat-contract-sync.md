# Sentinel → Eclipse Chat Office Event v1

## Статус синхронизации

Sentinel остаётся источником полномочий для локального safe operator: план, ручное подтверждение,
одноразовое выполнение и receipt создаются только Sentinel Runtime. Eclipse Chat, 2D/3D и Presence
получают безопасную проекцию и не могут подтверждать план или выполнять действие.

`office/sentinel-office-bridge.mjs` формирует внутреннее событие-проекцию Sentinel.
`office/eclipse-chat-office-adapter.mjs` преобразует его в точный `OfficeEventInput` Eclipse Chat:

```text
{ workspaceId, type, subject: { kind, id }, summary, metadata }
```

`id`, `sequence` и `occurredAt` добавляет только Office Core после проверки входа. Внутри события
нет `cursor`: числовой `cursor` принадлежит ответу read endpoint и соответствует последней
последовательности workspace.

## Карта событий

| Sentinel projection | Eclipse Chat Office event |
| --- | --- |
| `sentinel.operator.plan-projected.v1` | `task.created`, `approval.requested` |
| `sentinel.operator.execution-projected.v1` | `approval.resolved`, `task.started` |
| `sentinel.operator.receipt-projected.v1` | `task.completed` |
| `sentinel.operator.blocked.v1` | `task.failed` |
| `sentinel.presence.snapshot.v1` | `agent.state.changed` |
| `sentinel.safety.boundary.v1` | `agent.state.changed` |

Исходная команда, свободный текст receipt, речь, строки вывода, локальные пути и значения секретов
не входят в `metadata`. Metadata содержит максимум 20 скалярных полей; ключи с
`authorization`, `cookie`, `credential`, `password`, `private-key`, `secret`, `token` и `api-key`
отклоняются без публикации.

## Граница транспорта и авторизации

Текущий `GET /api/servers/:id/office/events?after=<sequence>&limit=<n>` в Eclipse Chat — только
чтение. Он защищён JWT, membership-проверкой, workspace isolation и rate limit, но не является
каналом публикации Sentinel.

Sentinel-side P1d transport реализован отдельным модулем
`office/eclipse-chat-office-ingest-client.mjs`. Он отправляет атомарный `OfficeEventInput[1..50]`
только в `POST /api/servers/:workspaceId/office/events/ingest`, подписывает каноническое тело
HMAC-SHA-256, ограничивает origin/размер/таймаут/retry и строго проверяет persisted events. Полный
wire-контракт зафиксирован в `docs/contracts/eclipse-chat-office-ingest-v1.md`.

Для безопасного включения runtime стороне Eclipse Chat необходим подтверждённый internal publisher:

1. key id привязан к одному producer и allowlist workspace; secret хранится вне renderer/repository;
2. авторизация только на создание allowlisted `OfficeEventInput`, без права задавать `id`,
   `sequence`, `occurredAt` или другой workspace;
3. строгая schema validation и тот же sensitive-key filter до записи;
4. durable idempotency по `(keyId, nonce, workspaceId, bodyHash)`: одинаковый replay возвращает
   сохранённый 2xx, а nonce с другим hash возвращает 409;
5. атомарный batch для пар `task.created + approval.requested` и
   `approval.resolved + task.started`, чтобы не возникало половинчатого состояния;
6. точный 2xx `{schemaVersion, source, events, cursor}` без свободного payload и без логирования
   credential; `cursor` равен последнему server-assigned `sequence`;
7. constant-time HMAC compare, timestamp skew не более пяти минут и durable nonce transaction;
8. TLS для удалённой установки; явный loopback-only режим допустим для локальной разработки.

`createEclipseChatOfficePublisher` принимает `publishBatch` реализованного ingest-клиента. Он обязан
вызывать Office Core, а не писать напрямую в Presence, 2D/3D или их локальное хранилище.
Electron main process теперь собирает этот publisher через `office/sentinel-office-runtime.mjs` только
при `SENTINEL_OFFICE_ENABLED=1`. Origin должен быть точным HTTPS origin; HTTP разрешается только для
явно включённого loopback-режима. Secret читается по фиксированному producer identity из Windows
Credential Manager и не передаётся renderer. Локальный PostgreSQL restart/replay E2E пройден;
неразрешённым остаётся только production provisioning/rotation реального producer credential.

## Машинные контракты и проверки

- `docs/contracts/sentinel-office-event-v1.schema.json` — внутренний projection envelope Sentinel;
- `docs/contracts/eclipse-chat-office-event-v1.schema.json` — канонический Eclipse Chat
  `office.event.v1` и его входной `OfficeEventInput`;
- `docs/contracts/eclipse-chat-office-ingest-v1.md` — HMAC, canonical JSON, atomic batch,
  идемпотентность и точный response envelope;
- `scripts/eclipse-chat-office-adapter.test.mjs` — mapping, workspace isolation, секреты и receipts;
- `scripts/eclipse-chat-office-ingest-client.test.mjs` — signing, retry, timeout, SSRF boundary и
  совместимость с атомарным publisher port;
- `scripts/eclipse-chat-office-schema.test.mjs` — JSON Schema parity;
- `scripts/sentinel-office-encoding.test.mjs` — строгий UTF-8 и защита кириллицы от mojibake.
