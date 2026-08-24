# Eclipse Chat Office Ingest v1

Статус Sentinel-клиента: реализован и покрыт локальными contract/security-тестами 2026-08-24.
Статус server-side: durable ingest, exact same-request 2xx replay и conflict rejection реализованы и
покрыты contract/security-тестами в Eclipse Chat Office Core. Live PostgreSQL restart/replay QA пройден.
Production producer `eclipse-hopson-sentinel` provision-ится из GitHub Environment только для workspace
`cmp2ksqyg00059j5kuqxoerqr`; подписанная доставка из Windows Credential Manager подтверждена событием
`agent.state.changed` с server-assigned `sequence: 1`.

## HTTP-контракт

```text
POST <basePath>/api/servers/<workspaceId>/office/events/ingest
content-type: application/json
x-office-key-id: <^[a-z0-9][a-z0-9._-]{0,63}$>
x-office-timestamp: <Unix milliseconds>
x-office-nonce: <UUID>
x-office-signature: v1=<64 lowercase hex characters>
```

Тело содержит от 1 до 50 событий и занимает не более 64 KiB в каноническом UTF-8
представлении:

```json
{
  "schemaVersion": "office.ingest.v1",
  "events": [
    {
      "workspaceId": "eclipse-forge",
      "type": "agent.state.changed",
      "subject": { "kind": "agent", "id": "sentinel" },
      "summary": "Sentinel presence changed",
      "metadata": { "state": "idle", "readOnly": true }
    }
  ]
}
```

Каждый `events[].workspaceId` обязан точно совпадать с path parameter и workspace, разрешённым
для `keyId`. `id`, `sequence` и `occurredAt` отсутствуют во входе: их атомарно назначает только
`workspaceId` не может содержать ASCII control characters: это исключает неоднозначность разделённых
переводами строк полей HMAC.
Office Core.

## Каноническая подпись

`stableCanonicalJson(body)` строится одинаково на обеих сторонах:

- ключи каждого объекта сортируются рекурсивно в лексикографическом порядке UTF-16 code units;
- принимаются только dense plain arrays без пропусков/добавочных свойств; их порядок сохраняется;
- строки сериализуются правилами JSON без Unicode normalization;
- байты хеша и запроса кодируются UTF-8;
- разрешены только JSON `null`, boolean, строки, конечные числа, массивы и plain objects;
- `-0` сериализуется как `0`; `NaN`, infinity, `undefined`, `bigint`, symbols, accessors,
  циклы, accessors, скрытые/символьные свойства и class/Date instances отклоняются.

Подписывается точная строка:

```text
office.ingest.v1\n<keyId>\n<workspaceId>\n<timestamp>\n<nonce>\n<sha256(stableCanonicalJson(body))>
```

`x-office-signature` равен `v1=` плюс lowercase hex HMAC-SHA-256 этой строки. Сервер сначала
проверяет формат и привязку ключа, затем сравнивает MAC constant-time операцией. Максимальное
отклонение времени — пять минут.

## Обязательная идемпотентность повторов

Простое правило «повтор nonce всегда 409» несовместимо с безопасным retry: первый запрос мог
атомарно записаться, а его 2xx-ответ — потеряться. Поэтому сервер хранит в durable storage запись
`(keyId, nonce, workspaceId, bodyHash, successfulResponse)` в одной транзакции с batch:

- первый корректный запрос выполняет атомарную запись и сохраняет точный успешный ответ;
- тот же `(keyId, nonce)` и тот же `workspaceId + bodyHash` возвращает сохранённый 2xx без
  повторной записи;
- тот же `(keyId, nonce)`, но другой workspace или body hash возвращает 409;
- запись переживает рестарт и хранится как минимум дольше окна timestamp/retry;
- одновременные запросы с одним nonce сериализуются уникальным ограничением/транзакцией.

Sentinel включает `maxAttempts > 1` только при явном `idempotentReplay: true`. Все попытки одного
batch повторяют точные timestamp, nonce, body и signature. Network error, timeout, 3xx и 5xx могут
повторяться не более трёх раз. Любой 4xx и любой определённый 2xx завершают retry; невалидный 2xx
считается нарушением контракта и не отправляется повторно.

## Успешный ответ

Office Core возвращает только точный JSON envelope, совпадающий с read API:

```json
{
  "schemaVersion": "office.event.v1",
  "source": "office-core-runtime",
  "events": [],
  "cursor": 42
}
```

`events` содержит ровно столько же элементов и в том же порядке, что и входной batch. В каждом
элементе входные поля неизменны, серверные `id`, `sequence`, `occurredAt` валидны, sequence строго
возрастает, а `cursor` равен последнему `sequence`. Ответ ограничен 256 KiB. Неизвестные поля,
не-JSON Content-Type и свободная форма отклоняются.

## Граница безопасности и эксплуатации

- `keyId` на сервере связан с `producerId`, точным allowlist workspace и отдельным secret;
- endpoint не принимает JWT пользователя, cookie, query credential или redirect;
- клиент разрешает только точный configured origin; HTTP возможен лишь для явно разрешённого
  loopback, удалённый endpoint требует HTTPS;
- отдельный `basePath` допускает только нормализованные сегменты `/[A-Za-z0-9_-]+` без trailing
  slash, query, fragment, dot-segments или смены origin; production использует `/eclipse-chat`;
- production secret загружается как bytes из Windows Credential Manager/DPAPI или эквивалентного
  service secret store, не из renderer, URL, события, Git, analytics или логов;
- серверные error bodies и transport exception text не попадают в Sentinel receipt/UI;
- rate limiting применяется после дешёвых проверок размера/формата и до дорогой обработки;
- HMAC-аутентификация не заменяет TLS: она подтверждает producer и целостность, но не скрывает body.

Sentinel-реализация: `office/eclipse-chat-office-ingest-client.mjs`. Она предоставляет атомарный
`publishBatch`, совместимый с `createEclipseChatOfficePublisher`. Production credential, scoped
server binding и одна безопасная signed delivery подтверждены; секрет не читался оператором и не
попадал в argv, Git, renderer, event metadata или логи.
