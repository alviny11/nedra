import type { ScenarioFile } from '@pipetwin/contracts/truth';
import { buildDemoPublic, defaultTruth, leak, scenarioFile } from './demoField';

/**
 * Reproducible demonstration scenarios. Each has a description, the expected PHYSICAL behaviour and
 * limitations. They are not answers for the diagnostician: it must infer everything from measurements.
 * Convention: calibration/warm-up window 0..180 s contains no hidden events.
 */
export function buildCatalog(): ScenarioFile[] {
  const pub = buildDemoPublic();
  const S: ScenarioFile[] = [];
  S.push(
    scenarioFile(
      'healthy_steady',
      'Штатный режим',
      'Нормальная работа без событий; флуктуации давления сепаратора и расходов кустов.',
      'Давления и расходы колеблются около рабочей точки; утечек нет.',
      pub,
      defaultTruth(101),
      ['normal']
    )
  );
  S.push(
    scenarioFile(
      'pump_ramp',
      'Снижение частоты насоса Н-1',
      'Плановая команда: частота Н-1 1.00 → 0.90 в t = 400 с (публичная команда).',
      'Падение напора и расхода Н-1, перераспределение давлений; массовый баланс сохраняется.',
      buildDemoPublic({ commands: [{ kind: 'pump_speed', id: 'cmd-p1', simTimeS: 400, targetId: 'P1', speedRatio: 0.9 }] }),
      defaultTruth(102),
      ['operating_change']
    )
  );
  S.push(
    scenarioFile(
      'valve_ramp',
      'Прикрытие задвижки ЗД-1',
      'Плановая команда: ЗД-1 0.60 → 0.45 в t = 400 с (ход 40 с).',
      'Рост давления перед задвижкой и по коллектору, снижение расхода на УПН; баланс сохраняется.',
      buildDemoPublic({ commands: [{ kind: 'valve_opening', id: 'cmd-v1', simTimeS: 400, targetId: 'V1', opening: 0.45 }] }),
      defaultTruth(103),
      ['operating_change']
    )
  );
  S.push(
    scenarioFile(
      'leak_abrupt_e4',
      'Резкая утечка на коллекторе e4',
      'Отверстие 20 мм на e4, 1100 м от У-1, мгновенное раскрытие в t = 420 с.',
      'Волна понижения давления расходится от места утечки со скоростью ~1180 м/с; дефицит массового баланса ~ расход утечки.',
      pub,
      defaultTruth(104, [leak('leak-1', 'e4', 1100, 420, 0.02)]),
      ['leak', 'abrupt']
    )
  );
  S.push(
    scenarioFile(
      'leak_abrupt_e2',
      'Резкая утечка на напорном e2',
      'Отверстие 15 мм на e2, 2300 м от Н-1, мгновенное раскрытие в t = 450 с.',
      'Волна от точки утечки; расход Н-1 растёт, расход на УПН падает.',
      pub,
      defaultTruth(105, [leak('leak-1', 'e2', 2300, 450, 0.015)]),
      ['leak', 'abrupt']
    )
  );
  S.push(
    scenarioFile(
      'leak_abrupt_e6',
      'Резкая утечка на коллекторе e6',
      'Отверстие 25 мм на e6, 600 м от У-2, раскрытие в t = 430 с.',
      'Сильная волна давления; падение давления перед ЗД-1 и расхода на УПН.',
      pub,
      defaultTruth(106, [leak('leak-1', 'e6', 600, 430, 0.025)]),
      ['leak', 'abrupt']
    )
  );
  S.push(
    scenarioFile(
      'leak_abrupt_e3',
      'Утечка на отводе Куст-3',
      'Отверстие 12 мм на e3, 900 м от Куст-3, раскрытие в t = 440 с.',
      'Падение давления на отводе и в узле У-1; расход Куст-3 задан источником, на УПН приходит меньше.',
      pub,
      defaultTruth(107, [leak('leak-1', 'e3', 900, 440, 0.012)]),
      ['leak', 'abrupt']
    )
  );
  S.push(
    scenarioFile(
      'leak_slow_e4',
      'Медленно раскрывающаяся утечка на e4',
      'Отверстие 20 мм на e4, 1900 м; площадь раскрывается за 240 с (smoothstep) начиная с t = 360 с.',
      'Нет резкого фронта волны; постепенный рост дефицита баланса и отклонений давлений.',
      pub,
      defaultTruth(108, [leak('leak-1', 'e4', 1900, 360, 0.02, 240)]),
      ['leak', 'slow'],
      ['Волновая локализация неприменима без резкого фронта; используется подбор по невязкам.']
    )
  );
  S.push(
    scenarioFile(
      'leak_water_line',
      'Утечка на водоводе (проверяемый прямой участок)',
      'Отверстие 15 мм на водоводе e9, 1100 м от С-1, раскрытие в t = 420 с. Датчики давления на 450 и 1350 м.',
      'Однородная прямая труба: формула x = (L + c(t_L - t_R))/2 между датчиками.',
      pub,
      defaultTruth(109, [leak('leak-1', 'e9', 1100, 420, 0.015)]),
      ['leak', 'abrupt', 'single_pipe']
    )
  );
  S.push(
    scenarioFile(
      'sensor_bias_pt107',
      'Смещение датчика PT-107',
      'Скрытая неисправность: ступенчатое смещение +0.3 бар у PT-107 (У-2) в t = 420 с.',
      'Физически ничего не меняется; отклоняется только один датчик, соседи и баланс в норме.',
      pub,
      defaultTruth(110, [{ kind: 'sensor_fault', eventId: 'fault-1', sensorId: 'PT-107', startTimeS: 420, fault: { type: 'bias_step', biasSI: 30000 } }]),
      ['sensor_fault']
    )
  );
  S.push(
    scenarioFile(
      'sensor_dropout_noisy',
      'Пропуски и шум датчиков',
      'PT-104: шум ×4 с t = 300 с; FT-104: 30% пропусков с t = 300 с.',
      'Физика без изменений; качество измерений ухудшено.',
      pub,
      defaultTruth(111, [
        { kind: 'sensor_fault', eventId: 'fault-1', sensorId: 'PT-104', startTimeS: 300, fault: { type: 'noise_increase', factor: 4 } },
        { kind: 'sensor_fault', eventId: 'fault-2', sensorId: 'FT-104', startTimeS: 300, fault: { type: 'dropout', probability: 0.3 } }
      ]),
      ['sensor_fault', 'data_quality']
    )
  );
  S.push(
    scenarioFile(
      'inlet_cooling',
      'Охлаждение продукции С-1',
      'Скрытое изменение: температура жидкости С-1 50 → 28 °C за 120 с с t = 300 с (отказ подогрева). Видно только по TT-101. Длительность 1500 с.',
      'Холодный фронт идёт по e1/e2 со скоростью потока (~2 м/с); растёт вязкость и потери давления на охлаждённой части.',
      buildDemoPublic({ durationS: 1500 }),
      defaultTruth(112, [{ kind: 'inlet_change', eventId: 'cool-1', nodeId: 'sep1', startTimeS: 300, rampDurationS: 120, temperatureK: 301.15 }]),
      ['temperature_change', 'normal']
    )
  );
  S.push(
    scenarioFile(
      'composition_change',
      'Рост обводнённости Куст-3',
      'Скрытое изменение: Y_w Куст-3 0.30 → 0.42 за 60 с с t = 300 с. Видно только по WC-102. Длительность 1500 с.',
      'Фронт состава движется по e3 (~1.2 м/с); эффективная вязкость эмульсии растёт, давление Куст-3 растёт.',
      buildDemoPublic({ durationS: 1500 }),
      defaultTruth(113, [{ kind: 'inlet_change', eventId: 'wc-1', nodeId: 'k3', startTimeS: 300, rampDurationS: 60, waterMassFraction: 0.42 }]),
      ['composition_change', 'normal']
    )
  );
  S.push(
    scenarioFile(
      'leak_plus_sensor_fault',
      'Отложенный тест: смещение датчика + утечка',
      'PT-105 смещается на −0.25 бар в t = 300 с, затем утечка 20 мм на e6 (1500 м) в t = 480 с.',
      'Сначала единичное отклонение датчика, затем физическая утечка с волной и дефицитом баланса.',
      pub,
      defaultTruth(114, [
        { kind: 'sensor_fault', eventId: 'fault-1', sensorId: 'PT-105', startTimeS: 300, fault: { type: 'bias_step', biasSI: -25000 } },
        leak('leak-1', 'e6', 1500, 480, 0.02)
      ]),
      ['leak', 'sensor_fault', 'held_out']
    )
  );
  S.push(
    scenarioFile(
      'leak_abrupt_e4_lowrate',
      'Резкая утечка e4, низкочастотные датчики (1 Гц)',
      'Как leak_abrupt_e4, но давление опрашивается с частотой 1 Гц (τ = 0.5 с).',
      'Обнаружение по балансу/невязкам; волновая локализация с ошибкой порядка c·δt/2 ~ сотни метров.',
      buildDemoPublic({ sensorProfile: 'low_rate' }),
      defaultTruth(115, [leak('leak-1', 'e4', 1100, 420, 0.02)]),
      ['leak', 'abrupt', 'low_rate']
    )
  );
  S.push(
    scenarioFile(
      'model_mismatch_healthy',
      'Штатный режим при расхождении свойств',
      'Истинная вязкость на 15% выше паспортной, шероховатость ×1.3: модель наблюдателя систематически ошибается.',
      'Нет событий; проверка устойчивости к ошибке модели.',
      pub,
      defaultTruth(116, [], { propertyDeviation: { viscosityFactor: 1.15, bulkModulusFactor: 0.97, roughnessFactor: 1.3 } }),
      ['normal', 'robustness']
    )
  );
  return S;
}
