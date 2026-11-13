# API (FastAPI, локальный, один пользователь)

Источник типов — `packages/contracts/schemas/openapi.json` (генерируется `python -m pipetwin_ml.cli schemas`), из него — `apps/web/src/api/schema.d.ts` (`npm run gen:api -w @pipetwin/web`). Доменные контракты дополнительно версионируются JSON Schema (`*.schema.json`), и TS (Ajv) и Python (Pydantic) проверяют одни и те же фикстуры `tests/fixtures`.

Запуск: `cd backend && uvicorn app.main:app --port 8000`. Документация: `http://127.0.0.1:8000/docs`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | /api/health | версия, наличие хранилища, runner, реестра моделей |
| GET | /api/capabilities | реально доступные модели (M0 supported; M1 experiment_only; HEM/drift-flux not_implemented; `serverPhysics: false`) |
| GET | /api/fluid-profiles | паспорта сред с provenance и границами |
| GET | /api/scenarios | встроенные (`data/scenarios`) и сохранённые сценарии |
| POST | /api/scenarios/validate | структура + топология + совместимость без запуска |
| POST | /api/scenarios | сохранить валидный сценарий (идемпотентно по id) |
| GET | /api/scenarios/{id} | конфигурация оператора (включая скрытый блок truth) |
| GET | /api/scenarios/{id}/public | только публичная часть для диагностики |
| POST | /api/runs | регистрация прогона, hash, версии |
| POST | /api/runs/{id}/measurements | пакет измерений; дубликат пакета → `duplicate: true` |
| POST | /api/runs/{id}/ground-truth | отдельный канал оценщика; помечает прогон завершённым |
| POST | /api/runs/{id}/diagnoses | запись диагнозов |
| GET | /api/runs/{id}/report | отчёт по прогону (`complete` только после записи истины) |
| POST | /api/jobs/dataset | генерация набора через headless TS runner (отдельный процесс, массив аргументов) |
| POST | /api/jobs/train | обучение по существующим datasetId |
| POST | /api/jobs/evaluate | оценка артефакта на фиксированном наборе |
| GET | /api/jobs/{id} | queued/running/succeeded/failed/cancelled + progress |
| POST | /api/jobs/{id}/cancel | остановка |
| GET | /api/models | реестр, статус parity и калибровки |
| GET | /api/models/{id}/artifact | JSON-артефакт для браузерного inference |

Ошибки: `{code, message, fieldPath?, details?}`; коды: `INVALID_SCHEMA`, `INVALID_TOPOLOGY`, `PROFILE_OUT_OF_RANGE`, `UNSUPPORTED_PHASE_REGIME`, `NUMERICAL_DIVERGENCE`, `INSUFFICIENT_SENSOR_DATA`, `MODEL_SCHEMA_MISMATCH`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RUNNER_UNAVAILABLE`.

Безопасность локального прототипа: идентификаторы проверяются регулярным выражением `^[A-Za-z0-9_.-]{1,64}$` и не превращаются в произвольные пути; JSON не исполняется, pickle не принимается; размер тела ≤ 32 МБ, пакет ≤ 200 000 отсчётов; NaN/Infinity отклоняются; CORS только для localhost. Многопользовательская безопасность не заявляется.
