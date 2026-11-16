# PipeTwin

Браузерный цифровой двойник небольшой промысловой трубопроводной сети: нестационарная гидравлика жидкости (метод характеристик), теплопотери и перенос состава, утечки через отверстие, модель датчиков и **независимая** диагностика по виртуальным измерениям (D0 — порог, D1 — физика + CUSUM + баланс + локализация, D2 — D1 + классификатор причин).

Объект и все свойства среды — **синтетические**. См. `docs/limitations.md`.

## Быстрый старт

Требования: Node ≥ 20 (проверено 22.x), Python ≥ 3.11 (проверено 3.13), Chrome — только для e2e.

```bash
npm ci                                  # TS-зависимости (lockfile)
npm run build:runner                    # headless runner (тот же TS-код, что в браузере)
npm run dev                             # фронтенд: http://localhost:5173
# опционально, бэкенд (сохранение сценариев/прогонов, jobs, реестр моделей):
pip install -r backend/requirements.lock   # точные версии (прямые зависимости — requirements.txt)
cd backend && uvicorn app.main:app --port 8000
```

Без бэкенда работают симуляция, датчики, D0/D1 и D2 со встроенным артефактом модели; в шапке видно «сервер офлайн», сохранение уходит в файл. Docker не обязателен.

Сборка в один HTML-файл для офлайн-показа: `npm run build:single -w @pipetwin/web` → `apps/web/dist-single/index.html` (после сборки открывается в Chrome двойным щелчком, без сервера и сети).

Сгенерированные прогоны наборов (`data/datasets/*/runs`, ≈ 35 МБ) лежат в отдельном архиве `pipetwin-datasets-v2.zip` — распаковать в корень репозитория; без него всё воспроизводится командами из раздела «ML-конвейер» (≈ 25 минут на двух ядрах).

## Сценарий демонстрации (≈ 5 минут)

1. Выбрать «Штатный режим», скорость ×10…×30, «Пуск». До 180 с идёт калибровка нормального режима (детекторы «недоступно»).
2. Нажать на коллектор e4 (У-1 → У-2), вкладка «Эксперимент» → «Указать место на схеме» → клик по трубе → «Внести утечку» (20 мм).
3. Слой «Волны Δp» показывает расчётный фронт волны; D1/D2 переходят в «подтверждено / утечка», на схеме — оранжевая зона кандидатов (время прихода фронта, затем подбор по невязкам), оценка расхода по балансу.
4. Переключиться в «Диагност»: красного маркера истины нет, поле на схеме — из наблюдателя; «Раскрыть истину» показывает реальное место.
5. Сценарии «Снижение частоты насоса», «Охлаждение продукции С-1», «Рост обводнённости Куст-3», «Смещение датчика PT-107» показывают, что штатное изменение режима, свойства среды и неисправность датчика — **не** утечка для D1 (смещение PT-107 он называет неисправностью датчика), тогда как D0 (фиксированные свойства) даёт ложную тревогу «утечка» на насосе, охлаждении и смещении датчика.
6. «Испытания» — таблица D0/D1/D2 на отложенных наборах; «M1» — акустический эксперимент для газосодержащей линии (формула Вуда).
7. «Экспорт» — CSV измерений + JSON отчёта (истина отдельным блоком, сценарий для повтора с тем же seed).

## Структура

```
packages/contracts         версионированные контракты (public / truth разделены) + JSON Schema + OpenAPI
packages/physics-core      физика без React/DOM: свойства, трение, сеть, MOC, утечки, тепло/состав, датчики;
                           ./truth — генератор (скрытые события) — только для симулятора и оценщика
packages/diagnostics-core  наблюдатели, невязки, CUSUM, баланс, локализация, признаки, inference (без truth)
packages/evaluation        сопоставление тревог с истиной, метрики, бутстрап по прогонам
tools/headless-runner      CLI: сценарии, прогоны, датасеты, испытания, parity, verification benches
apps/web                   React + Vite: схема, инспектор, графики, диагностика, испытания, workers
backend/app                FastAPI + Pydantic + SQLite + jobs (отдельные процессы)
backend/pipetwin_ml        датасеты → метки → обучение → экспорт → оценка
backend/reference          независимые проверки: аналитика, NumPy MOC, EPANET (WNTR)
data/                      профили, сценарии, датасеты (manifest), модели, отчёты испытаний
docs/                      model.md, api.md, validation.md, limitations.md
```

## Команды проверки

```bash
npm run typecheck                         # strict TS по всем пакетам
npm test                                  # vitest: физика, диагностика, контракты, оценщик
cd backend && python -m pytest -q         # API, схемы (те же фикстуры), ML, независимые физические проверки
npm run e2e                               # Playwright (системный Chrome): демо-сценарий, офлайн-режим
```

## ML-конвейер и испытания

```bash
R=tools/headless-runner/dist/pipetwin-runner.mjs
node $R dataset --out data/datasets/train-v2 --count 100 --seed 1000      # обучающие прогоны (истина — отдельным файлом)
node $R dataset --out data/datasets/val-v2   --count 30  --seed 2000
cd backend && python -m pipetwin_ml.cli train --train ../data/datasets/train-v2 --validation ../data/datasets/val-v2 --out ../data/models/logreg-v2 && cd ..
# отложенные наборы: новые диапазоны seed, D2 с обученной моделью
node $R dataset --out data/datasets/test-v2    --count 40 --seed 6000 --model data/models/logreg-v2/model.json
node $R dataset --out data/datasets/ood-v2     --count 20 --seed 7000 --spec ood     --model data/models/logreg-v2/model.json
node $R dataset --out data/datasets/heldout-v2 --count 16 --seed 8000 --spec heldout --model data/models/logreg-v2/model.json
node $R evaluate-runs --dirs data/datasets/test-v2 --out data/benchmarks/test-v2          # события: D0/D1/D2
cd backend && python -m pipetwin_ml.cli evaluate --dataset ../data/datasets/test-v2 --model ../data/models/logreg-v2/model.json && cd ..   # окна: классификатор
node $R benchmark --out data/benchmarks/catalog --model data/models/logreg-v2/model.json  # 16 сценариев каталога
```

Генерацию можно разделить на процессы: `--workers-index i --workers-total k` (один каталог, разные прогоны). 200 прогонов по 15 мин модельного времени — около 25 минут на двух ядрах.

Независимые проверки физики и производительность:

```bash
cd backend && python -m reference.report --out ../data/benchmarks/verification/reference.json && cd ..   # Жуковский, MOC, EPANET, Вуд
node $R bench-mesh --out data/benchmarks/verification/mesh.json
node $R bench-perf --out data/benchmarks/verification/perf.json
```

Те же шаги доступны через API (`/api/jobs/dataset`, `/api/jobs/train`, `/api/jobs/evaluate`). Протокол, все числа и разбор ошибок — `docs/validation.md`; результаты до исправлений — `data/archive/v1-before-fix/`.


## Прогноз деградации по реальным данным

Добавлен автономный модуль подготовки сегментов, проверки по историческим ВТД и прогноза толщины. Запуск, ограничения и выходные файлы: [docs/corrosion.md](docs/corrosion.md). Исходные CSV передаются через `--data-dir`, в репозиторий автоматически не копируются.


## Текущий результат двух кейсов

`python forecast.py` формирует `data/forecasts/result.csv`: 525 сегментов Random Forest для объекта 1250022871 и 1 475 сегментов прогноза по высотному профилю для объекта 1250009583. Зависимости расчёта: `backend_bundle/requirements.txt`. Модель первого кейса и подготовленные признаки лежат в `backend_bundle/`, исходные данные второго — в `data/ili/`.

Карточка трубы использует этот CSV, встроенный при сборке приложения. Кнопка скачивания отдаёт общий файл обоих кейсов — 2 000 строк данных. Открытие карточки не запускает модель. После изменения результата production-сборку нужно пересобрать. Серверный `GET /api/thickness/result.csv` также отдаёт сохранённый общий результат.
