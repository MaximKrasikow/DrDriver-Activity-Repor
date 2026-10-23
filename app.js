// ============================================================================
// КЛИЕНТСКАЯ ЛОГИКА PWA «ОТЧЕТ ЭКСПЕДИТОРА» — версия 3.3
// ============================================================================
// ЧТО НОВОГО В ВЕРСИИ 3.3 (решения владельца; детали — в помеченных блоках):
//   1. ПОДТВЕРЖДЕНИЕ ОТПРАВКИ: перед сохранением водитель видит окно
//      «Вы хотите отправить данный отчёт?» с краткой сводкой и кнопками
//      ДА / НЕТ. «НЕТ» (или Esc, или тап мимо окна) — форма остается как была.
//   2. ВРЕМЯ УПРОЩЕНО: время заполнения = часы телефона. Одинаково работает
//      офлайн и онлайн, никакой связи с сервером для этого не нужно.
//      Калибровка (timeOffset) и пометки timeSource удалены как лишние.
//   3. ОБРАТНАЯ СОВМЕСТИМОСТЬ УДАЛЕНА: один формат данных, никаких
//      «страховок для старых версий». Код однозначный.
//   4. ВЕДУЩИЕ НУЛИ СЧЕТЧИКА: поле идет текстом от телефона до таблицы
//      (сервер v3.3 ставит текстовый формат перед записью каждой строки).
//   Из v3.2 сохранены: несколько фото (MAX_PHOTOS), защита памяти (OOM),
//      reportId (защита от дублей — теперь невидимая, в памяти сервера),
//      лечение «ядовитой таблетки», FIFO по индексу by_created.
//   ВАЖНО ПРИ РЕЛИЗЕ: поднимите версию кэша в sw.js, иначе телефоны
//   продолжат работать со старым app.js из кэша.
// ============================================================================

const GAS_URL = 'https://script.google.com/macros/s/AKfycbyceW1oRstLa5Vq4HBZOJG-4pgln0Z1GbflV2tuvbsAd-lgQtLw62fNXAzMTVLPbQv9/exec';

// Таймаут одного запроса отчета, 90 секунд.
const REQUEST_TIMEOUT_MS = 90000;

// ============================================================================
// === НАСТРОЙКИ ФОТО — меняются под требования заказчика ===
// ============================================================================
const MAX_PHOTOS = 3;        // сколько фото можно приложить к ОДНОМУ отчету
const PHOTO_MAX_DIM = 1280;  // большая сторона фото после сжатия, пиксели
const PHOTO_QUALITY = 0.7;   // качество JPEG (0..1): меньше число = меньше файл

// SERVICE WORKER: регистрация офлайн-оболочки
// sw.js сохраняет файлы интерфейса (HTML/JS/иконки) в память телефона.
// ПРИ ОБНОВЛЕНИИ app.js не забывайте менять версию кэша в sw.js!
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('SW: регистрация не удалась:', err);
        });
    });
}

// ЗАЩИТА БАЗЫ ОТ АВТООЧИСТКИ БРАУЗЕРА: без этого браузер считает нашу базу
// «одноразовой» (best-effort) и имеет право стереть неотправленные отчеты
// при нехватке места на телефоне.
if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
}

// ============================================================================
// БЛОК 1: БАЗА ДАННЫХ INDEXEDDB — «диск телефона» для неотправленных отчетов
// ============================================================================
const DB_NAME = 'DriverReportsDB';    // имя базы на телефоне
const DB_VERSION = 2;                 // v2 = добавлен индекс by_created (НОВОЕ)
const STORE_NAME = 'reports_queue';   // «таблица» с очередью отчетов

// dbPromise кэширует открытую базу; повторные вызовы openDB() возвращают ее же.
let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        // onupgradeneeded: при самой первой установке (создание store)
        // ИЛИ при обновлении версии схемы (v1 -> v2: добавление индекса)
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            // НОВОЕ (v2): store мог уже существовать (обновление с v1) —
            // берем его из транзакции обновления, а не создаем заново.
            const store = db.objectStoreNames.contains(STORE_NAME)
                ? e.target.transaction.objectStore(STORE_NAME)
                : db.createObjectStore(STORE_NAME, { keyPath: 'id' });

            // НОВОЕ (v2): числовой индекс по времени создания.
            // Раньше FIFO шел по строковому ключу 'rep_<дата>_<мусор>' —
            // совпадение лексикографического порядка с хронологией было
            // случайным и сломалось бы при смене формата id. Числа
            // сортируются всегда правильно. Существующие записи v1
            // (у них поле createdAt уже было) проиндексируются автоматически.
            if (!store.indexNames.contains('by_created')) {
                store.createIndex('by_created', 'createdAt');
            }
        };

        req.onsuccess = () => {
            const db = req.result;
            // Если когда-нибудь повысим DB_VERSION, открытая база в других
            // вкладках честно закроется и не будет мешать обновлению схемы
            db.onversionchange = () => db.close();
            resolve(db);
        };
        req.onerror = () => {
            dbPromise = null; // следующая попытка будет с чистого листа
            reject(req.error);
        };
    });
    return dbPromise;
}

// ----------------------------------------------------------------------------
// Оборачиватель транзакций IndexedDB в Promise (put/delete/count).
// ----------------------------------------------------------------------------
function withStore(mode, operation) {
    return openDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = operation(tx.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
}

// Сохранить/обновить отчет в базе (put = вставка ИЛИ перезапись по id)
function dbPut(item) {
    return withStore('readwrite', (store) => store.put(item));
}

// Удалить отчет по id. Вызывается ТОЛЬКО после «success» от сервера
function dbDelete(id) {
    return withStore('readwrite', (store) => store.delete(id));
}

// Количество ВСЕХ отчетов в очереди (включая отложенные «ядовитые»).
function dbCount() {
    return withStore('readonly', (store) => store.count());
}

// НОВОЕ (v3.2): количество АКТИВНЫХ отчетов (без отложенных failed=true).
// Отложенные не должны влиять ни на счетчик на экране, ни на запуск синка.
function dbCountActive() {
    return openDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).openCursor(null, 'next');
        let n = 0;
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve(n);
            if (!c.value.failed) n++; // failed=true = отложен, не считаем
            c.continue();
        };
        req.onerror = () => reject(req.error);
    }));
}

// ----------------------------------------------------------------------------
// Самый старый АКТИВНЫЙ отчет — первый кандидат на отправку (FIFO).
// Идем по индексу by_created (число, порядок всегда верный) и ПРОПУСКАЕМ
// отложенные (failed=true) — так «ядовитый» отчет, который сервер отказался
// принимать, НЕ блокирует всю очередь (лечение Head-of-Line Blocking).
// ----------------------------------------------------------------------------
async function dbPeekOldest() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        // Индекс by_created создается гарантированно при открытии базы (v2)
        const req = tx.objectStore(STORE_NAME).index('by_created').openCursor(null, 'next');
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve(null);          // очередь пуста
            if (c.value && c.value.failed) { c.continue(); return; }
            resolve(c.value);
        };
        req.onerror = () => reject(req.error);
    });
}

// ============================================================================
// БЛОК 2: ИНТЕРФЕЙС И ДАТЧИКИ СЕТИ
// ============================================================================

// Ссылки на элементы экрана
const uIn = document.getElementById('username');
const pointIn = document.getElementById('pointName');
const photoIn = document.getElementById('photo');
const statusEl = document.getElementById('status');
const netStatusEl = document.getElementById('netStatus');
const submitBtn = document.getElementById('submitBtn');

// НОВОЕ (v3.2): контейнер превью-списка фото и подпись с лимитом
const photoListEl = document.getElementById('photoList');
const photoLimitEl = document.getElementById('photoLimit');

// НОВОЕ (v3.2): показываем лимит фото из константы прямо в подписи поля —
// если поменяете MAX_PHOTOS, надпись на экране обновится сама
if (photoLimitEl) photoLimitEl.textContent = MAX_PHOTOS;

// ----------------------------------------------------------------------------
// НОВОЕ (v3.2): МЕНЕДЖЕР ВЫБОРА ФОТО.
// Состояние — массив File (максимум MAX_PHOTOS). Input после каждого выбора
// сбрасывается (photoIn.value=''), поэтому один и тот же файл можно выбрать
// повторно, а «двойной тап» не задублирует его.
// ----------------------------------------------------------------------------
let selectedPhotos = [];

photoIn.addEventListener('change', () => {
    const incoming = Array.from(photoIn.files || []);
    const free = MAX_PHOTOS - selectedPhotos.length;
    if (incoming.length > free) {
        alert('Можно приложить не более ' + MAX_PHOTOS + ' фото. Лишние файлы не добавлены.');
    }
    selectedPhotos = selectedPhotos.concat(incoming.slice(0, Math.max(free, 0)));
    photoIn.value = ''; // сброс: тот же файл можно выбрать повторно
    renderPhotoList();
});

// Рисуем превью-список выбранных фото. textContent (не innerHTML) — защита
// от injection через имя файла.
function renderPhotoList() {
    if (!photoListEl) return;
    photoListEl.innerHTML = '';
    selectedPhotos.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'photo-item';

        const name = document.createElement('span');
        name.className = 'photo-name';
        name.textContent = (i + 1) + '. ' + f.name;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'photo-remove';
        btn.dataset.index = String(i);
        btn.textContent = '✕';

        row.appendChild(name);
        row.appendChild(btn);
        photoListEl.appendChild(row);
    });
}

// Удаление фото из списка: один слушатель на контейнер (делегирование) —
// работает для любых элементов, перерисовка списка не вешает обработчики.
if (photoListEl) {
    photoListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.photo-remove');
        if (!btn) return;
        selectedPhotos.splice(Number(btn.dataset.index), 1);
        renderPhotoList();
    });
}

// ----------------------------------------------------------------------------
// ФИО водителя — в localStorage (отдельно от базы отчетов).
// ----------------------------------------------------------------------------
uIn.value = localStorage.getItem('drv') || '';
uIn.oninput = () => localStorage.setItem('drv', uIn.value.trim());

// ----------------------------------------------------------------------------
// Обновление статусной строки и плашки сети. Вызывается при старте,
// при смене сети и при каждом возврате на экран приложения.
// ----------------------------------------------------------------------------
async function updateStatusUI() {
    let total = 0;
    let active = 0;
    try {
        total = await dbCount();
        active = await dbCountActive();
    } catch (e) {
        console.warn('База данных недоступна:', e);
        statusEl.innerText = 'Ошибка базы данных. Перезапустите приложение.';
        return;
    }
    const deferred = total - active; // отложенные «ядовитые» отчеты

    if (navigator.onLine) {
        netStatusEl.className = 'badge online';
        netStatusEl.innerText = '● Подключение: Онлайн';

        if (active > 0) {
            statusEl.innerText = `В очереди: ${active} отчетов` +
                (deferred > 0 ? `, отложено: ${deferred}` : '') + '. Начинаю выгрузку...';
            syncQueue();
        } else {
            statusEl.innerText = deferred > 0
                ? `Отложено из-за отказов сервера: ${deferred} (не блокируют новые отчеты).`
                : 'Готово к заполнению';
        }
    } else {
        netStatusEl.className = 'badge offline';
        netStatusEl.innerText = '○ Подключение: Офлайн (накопление)';
        statusEl.innerText = active > 0
            ? `Офлайн. В памяти: ${active} отчетов` + (deferred > 0 ? `, отложено: ${deferred}` : '') +
              ' — отправятся автоматически при появлении сети.'
            : deferred > 0
                ? `Офлайн. Отложено из-за отказов сервера: ${deferred}. Новые отчеты сохранятся в памяти телефона.`
                : 'Офлайн. Заполните отчет — он сохранится в памяти телефона.';
    }
}

// ----------------------------------------------------------------------------
// КОГДА ЗАПУСКАЕТСЯ СИНХРОНИЗАЦИЯ (4 триггера — важно для трассы):
//   online/offline  — момент смены подключения;
//   visibilitychange— водитель вернулся в приложение из фона.
//   focus           — дополнительная подстраховка для десктопа и старых
//                     моделей, где visibilitychange ведет себя нестандартно.
// ----------------------------------------------------------------------------
window.addEventListener('online', updateStatusUI);
window.addEventListener('offline', updateStatusUI);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateStatusUI();
});
window.addEventListener('focus', updateStatusUI);

// ============================================================================
// БЛОК 3: СЖАТИЕ ФОТОГРАФИЙ (v3.2 — защита от падения памяти)
// ----------------------------------------------------------------------------
// ПРОБЛЕМА, КОТОРУЮ ЛЕЧИМ: камера телефона дает фото 10-25 МБ (12-48 Мп).
// Старый код читал файл через FileReader.readAsDataURL — файл целиком
// превращался в base64-строку в памяти (20 МБ файл = строка ~27 МБ) и потом
// РАЗВОРАЧИВАЛСЯ в картинку полного размера (48 Мп = ~190 МБ ОЗУ). На
// бюджетных телефонах вкладка падала (Out Of Memory) прямо при выборе фото,
// и форма сбрасывалась.
// РЕШЕНИЕ: createImageBitmap(file) — браузер декодирует картинку НАПРЯМУЮ
// из файла: без base64-строки, сразу с правильным поворотом (EXIF). Затем
// рисуем в уменьшенный canvas и освобождаем память (bmp.close()).
// Для старых браузеров — запасной путь через Blob-URL: тоже без base64,
// в разы дешевле по памяти, чем старый readAsDataURL.
// ============================================================================

// ----------------------------------------------------------------------------
// Общая часть обоих путей: уменьшение до PHOTO_MAX_DIM, белая подложка
// (JPEG не умеет прозрачность — иначе PNG с альфа-каналом станет черным)
// и конвертация в JPEG-Base64. Размеры и качество — из констант сверху.
// ----------------------------------------------------------------------------
function canvasToJpegBase64(srcW, srcH, draw) {
    let w = srcW;
    let h = srcH;
    if (!w || !h) throw new Error('фото пустое или повреждено');

    // Пропорциональное уменьшение только если сторона больше лимита
    if (w > PHOTO_MAX_DIM || h > PHOTO_MAX_DIM) {
        if (w > h) {
            h = Math.round((h * PHOTO_MAX_DIM) / w);
            w = PHOTO_MAX_DIM;
        } else {
            w = Math.round((w * PHOTO_MAX_DIM) / h);
            h = PHOTO_MAX_DIM;
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    draw(ctx, w, h);
    // toDataURL выдает 'data:image/jpeg;base64,....' — отрезаем заголовок
    return canvas.toDataURL('image/jpeg', PHOTO_QUALITY).split(',')[1];
}

/**
 * @param {File} file - файл из input или undefined (фото необязательно)
 * @returns {Promise<string|null>} чистый Base64 без data:-заголовка, либо null
 */
async function compressImage(file) {
    if (!file) return null; // отчет без фото — валидный отчет

    // Валидация типа: битый файл или случайный документ — ошибка на экране.
    if (!file.type || !file.type.startsWith('image/')) {
        throw new Error('выбранный файл — не изображение');
    }

    // ПУТЬ 1 (современные Android Chrome / iOS 15+): createImageBitmap.
    // Декодирует из файла напрямую — пик памяти в разы меньше старого пути.
    if (typeof createImageBitmap === 'function') {
        let bmp = null;
        try {
            try {
                // from-image = сразу правильный поворот по EXIF
                bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
            } catch (orientErr) {
                bmp = await createImageBitmap(file); // опция не поддержана — без поворота
            }
            return canvasToJpegBase64(
                bmp.width, bmp.height,
                (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h)
            );
        } catch (e) {
            // декодирование не удалось (битый файл / лимиты браузера) —
            // падаем в запасной путь ниже
        } finally {
            // Освобождаем память СРАЗУ после рисования, не ждем GC
            if (bmp && bmp.close) bmp.close();
        }
    }

    // ПУТЬ 2 (старые браузеры): Blob-URL вместо readAsDataURL —
    // в памяти нет гигантской base64-строки, только сам <img>.
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('браузер не смог открыть фото (нужен JPEG или PNG)'));
        };
        img.onload = () => {
            try {
                const result = canvasToJpegBase64(
                    img.naturalWidth, img.naturalHeight,
                    (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h)
                );
                URL.revokeObjectURL(url);
                resolve(result);
            } catch (convErr) {
                URL.revokeObjectURL(url);
                reject(new Error('не удалось обработать фото'));
            }
        };
        img.src = url;
    });
}

// ----------------------------------------------------------------------------
// Очистка полей после УСПЕШНОГО сохранения отчета в базу.
// ФИО сознательно не чистится. НОВОЕ: сбрасываем и список выбранных фото.
// ----------------------------------------------------------------------------
function clearForm() {
    ['pointName', 'meter', 'smallToys', 'zamanukha', 'probros', 'problems', 'photo'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    selectedPhotos = [];
    renderPhotoList();
}

// ============================================================================
// БЛОК 4: ОТПРАВКА ОДНОГО ОТЧЕТА НА СЕРВЕР
// ============================================================================

async function sendReportToServer(item) {
    // Единый пакет: текст и ВСЕ фото атомарно одним запросом.
    // Формат ОДИН, без вариантов под старые версии (решение владельца v3.3).
    const payload = {
        action: 'REPORT',
        reportId: item.id,          // уникальный id: сервер не запишет отчет дважды
        user: item.user,
        pointName: item.pointName,
        meter: item.meter,          // строка как есть: '0057' не равно '57'
        smallToys: item.smallToys,
        zamanukha: item.zamanukha,
        probros: item.probros,
        problems: item.problems,
        createdAt: item.createdAt,  // время заполнения (часы телефона), в мс
        photos: item.photos || []   // массив Base64, может быть пустым
    };

    // Таймаут: AbortController разрывает соединение через 90 секунд.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
        // Content-Type text/plain (а не application/json) — иначе браузер
        // пошлет OPTIONS-preflight, который GAS не поддерживает.
        const response = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            signal: ctrl.signal
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('нет доступа к серверу отчетов — сообщите руководителю');
            }
            if (response.status >= 500) {
                throw new Error('сервер Google временно недоступен');
            }
            // НОВОЕ: прочие 4xx НЕ считаем «ядовитыми» — неверный URL/настройка
            // деплоя лечится, и откладывать все отчеты подряд было бы опасно.
            throw new Error('сбой сети, код ' + response.status);
        }

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseErr) {
            // Вместо JSON пришел вход в Google или заглушка провайдера —
            // отчет НЕ удаляем, повтор будет
            throw new Error('сервер вернул неожиданный ответ — повторите попытку');
        }

        if (data.status !== 'success') {
            // НОВОЕ (v3.2): разбор кодов ошибок сервера.
            // permanent=true ТОЛЬКО если сервер ЯВНО отказал по содержанию
            // (VALIDATION) — такой отчет не будет принят никогда, и его
            // нужно отложить в сторону, а не зацикливаться на нем.
            // BUSY/SERVER/сеть — временные: повтор позже имеет смысл.
            const e = new Error(data.message || 'ошибка обработки отчета на сервере — повторите попытку');
            e.permanent = (data.code === 'VALIDATION');
            throw e;
        }

        return data;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('превышено время ожидания (нет устойчивого интернета)');
        }
        throw err;
    } finally {
        clearTimeout(timer); // не копим «спящие» таймеры после каждого запроса
    }
}

// ============================================================================
// БЛОК 5: КНОПКА «ОТПРАВИТЬ ДАННЫЕ» + ПОДТВЕРЖДЕНИЕ (ДА / НЕТ)
// ============================================================================
// НОВОЕ (v3.3): между заполнением и отправкой стоит подтверждение —
// водитель видит окно «Вы хотите отправить данный отчёт?» с краткой сводкой.
// «ДА» — продолжаем; «НЕТ», Esc или тап мимо окна — ничего не происходит,
// форма остается заполненной. Поток: ШАГ 1 (проверка + окно) -> ШАГ 2 (ДА).
// ============================================================================

const confirmOverlay = document.getElementById('confirmOverlay');
const confirmSummary = document.getElementById('confirmSummary');
const confirmYesBtn = document.getElementById('confirmYes');
const confirmNoBtn = document.getElementById('confirmNo');
let confirmAction = null; // что выполнить при «ДА»

function askConfirm(summaryText, onYes) {
    confirmSummary.textContent = summaryText;
    confirmAction = onYes;
    confirmOverlay.classList.remove('hidden');
    confirmYesBtn.focus(); // Enter = «ДА», Esc = «НЕТ»
}

function hideConfirm() {
    confirmOverlay.classList.add('hidden');
    confirmAction = null;
}

confirmYesBtn.addEventListener('click', () => {
    const action = confirmAction;
    hideConfirm();
    if (action) action();
});
confirmNoBtn.addEventListener('click', hideConfirm);
// Тап по темному фону вокруг окна = «НЕТ»
confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) hideConfirm();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !confirmOverlay.classList.contains('hidden')) hideConfirm();
});

// ШАГ 1: прочитать и проверить поля, показать окно подтверждения
function handleFormSubmit() {
    // Считываем ВСЕ поля: значения фиксируются в момент нажатия кнопки
    const user = uIn.value.trim();
    const point = pointIn.value.trim();
    const meter = document.getElementById('meter').value.trim();
    const smallToys = document.getElementById('smallToys').value.trim();
    const zamanukha = document.getElementById('zamanukha').value.trim();
    const probros = document.getElementById('probros').value.trim();
    const problems = document.getElementById('problems').value.trim();

    // Список фото тоже фиксируем сразу — подтверждение ничего не меняет
    const files = selectedPhotos.slice();

    if (!user || !point) {
        alert('Заполните ФИО водителя и наименование точки!');
        return;
    }

    // Краткая сводка отчета для окна подтверждения. textContent (не innerHTML):
    // текст точки/проблем вставляется как текст, без интерпретации разметки
    const summary =
        'Водитель: ' + user + '\n' +
        'Точка: ' + point + '\n' +
        'Счетчик: ' + (meter || '—') + '\n' +
        'Мелкие: ' + (smallToys || '0') + ' | Заманухи: ' + (zamanukha || '0') + '\n' +
        'Проброс: ' + (probros || '—') + '\n' +
        'Проблемы: ' + (problems || 'нет') + '\n' +
        'Фото: ' + files.length + ' шт.';

    askConfirm(summary, () => processAndSave({
        user: user, point: point, meter: meter, smallToys: smallToys,
        zamanukha: zamanukha, probros: probros, problems: problems, files: files
    }));
}

// ШАГ 2 (после «ДА»): сжатие фото, запись в базу, выгрузка на сервер
async function processAndSave(form) {
    // Блокировка кнопки на все время обработки: защита от дублей при
    // нетерпеливых повторных тапах
    submitBtn.disabled = true;

    try {
        // Сжимаем фото ПО ОДНОМУ — видно прогресс и память освобождается
        // между файлами (не держим 3 раскрытых фото сразу).
        const photosBase64 = [];
        for (let i = 0; i < form.files.length; i++) {
            statusEl.innerText = 'Сжимаю фото ' + (i + 1) + ' из ' + form.files.length + '...';
            try {
                photosBase64.push(await compressImage(form.files[i]));
            } catch (photoErr) {
                // Ошибка конкретного фото: объясняем, форму НЕ чистим —
                // водитель уберет/заменит одно фото и нажмет кнопку снова.
                statusEl.innerText = 'Фото «' + form.files[i].name + '» не обработано: ' + photoErr.message +
                    '. Отчет НЕ сохранен — удалите это фото кнопкой ✕ или замените его и нажмите «Отправить».';
                return; // finally ниже разблокирует кнопку
            }
        }

        // Время заполнения — часы телефона (Date.now()). Работает ОДИНАКОВО
        // офлайн и онлайн, никакой связи с сервером для этого не нужно (v3.3).
        const createdAt = Date.now();

        // Самодостаточный объект отчета:
        //   photos    — массив Base64 всех фото (может быть пустым);
        //   createdAt — время заполнения в мс (FIFO-порядок + колонка в таблице).
        const item = {
            id: 'rep_' + createdAt + '_' + Math.random().toString(36).substring(2, 7),
            user: form.user,
            pointName: form.point,
            meter: form.meter,
            smallToys: form.smallToys,
            zamanukha: form.zamanukha,
            probros: form.probros,
            problems: form.problems,
            photos: photosBase64,
            timestamp: new Date(createdAt).toLocaleString('ru-RU'), // только для экрана
            createdAt: createdAt,
            retries: 0,
            lastError: null
        };

        // Offline-First: сначала диск, потом сеть
        try {
            await dbPut(item);
        } catch (dbErr) {
            if (dbErr && dbErr.name === 'QuotaExceededError') {
                statusEl.innerText = 'Память приложения на телефоне заполнена. Подключитесь к интернету — накопленные отчеты отправятся, и место освободится.';
                return;
            }
            throw dbErr;
        }

        clearForm(); // чистим форму только после фактической записи в базу

        if (!navigator.onLine) {
            const count = await dbCountActive();
            statusEl.innerText = `Отчет сохранен в памяти телефона (в очереди: ${count}). Отправится автоматически при появлении интернета.`;
            return;
        }

        await syncQueue();

    } catch (err) {
        console.error('Ошибка сохранения формы:', err);
        statusEl.innerText = 'Ошибка: ' + err.message + '. Данные остались на экране — попробуйте отправить еще раз.';
    } finally {
        // Кнопка разблокируется при ЛЮБОМ исходе
        submitBtn.disabled = false;
    }
}

// Привязка события из JS (а не onclick в HTML): логика в одном файле
submitBtn.addEventListener('click', handleFormSubmit);

// ============================================================================
// БЛОК 6: СИНХРОНИЗАТОР ОЧЕРЕДИ
// ============================================================================

// ----------------------------------------------------------------------------
// ЗАЩИТА ОТ ДВОЙНОЙ ОТПРАВКИ (замок на уровне всего сайта).
// Web Locks API — общий замок для всех вкладок; для старых браузеров —
// резервный флаг isSyncing. (Комментарий про механику — как в v3.1.)
// ----------------------------------------------------------------------------
const SYNC_LOCK_NAME = 'driver-report-sync';
let isSyncing = false;

async function syncQueue() {
    if (!navigator.onLine) return;

    if (navigator.locks && typeof navigator.locks.request === 'function') {
        await navigator.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => {
            if (!lock) return; // другая вкладка уже выгружает — пропускаем
            await doSyncCycle();
        });
    } else {
        if (isSyncing) return;
        isSyncing = true;
        try {
            await doSyncCycle();
        } finally {
            isSyncing = false;
        }
    }
}

// ----------------------------------------------------------------------------
// Сам цикл выгрузки. НОВОЕ (v3.2) — лечение «ЯДОВИТОЙ ТАБЛЕТКИ»
// (Head-of-Line Blocking):
//   РАНЬШЕ: любая ошибка отчета №1 -> break -> ВСЯ очередь стояла вечно.
//   ТЕПЕРЬ: ошибка различается по типу:
//     - err.permanent (код VALIDATION: сервер ЯВНО отказал в приеме —
//       плохие данные, повтор бессмыслен) -> отчет помечается failed=true
//       и ОТКЛАДЫВАЕТСЯ (НЕ удаляется — данные дороже!), цикл продолжается
//       со СЛЕДУЮЩЕГО отчета;
//     - временные ошибки (сеть, BUSY, 5xx) -> break, как раньше:
//       повтор при следующем возврате на экран.
// Отложенные отчеты пропускаются в dbPeekOldest и не мешают никому.
// ----------------------------------------------------------------------------
async function doSyncCycle() {
    try {
        // СТРАХОВКА ОТ ЗАЦИКЛИВАНИЯ: какие отчеты уже обработаны в ЭТОМ цикле.
        // Нормально обработанный отчет исчезает из очереди активных (failed-флаг
        // или удаление после success). Но если запись в базу вдруг не прошла
        // (сбой IndexedDB), на следующей итерации вернулся бы ТОТ ЖЕ отчет,
        // и цикл крутился бы бесконечно. Set гарантирует: каждый отчет
        // обрабатывается максимум ОДИН раз за цикл, остальное — до следующего
        // триггера синхронизации (online/focus/возврат на экран).
        const handledInCycle = new Set();

        while (navigator.onLine) {
            // Берем самый старый АКТИВНЫЙ отчет (отложенные пропускаются)
            const item = await dbPeekOldest();
            if (!item || handledInCycle.has(item.id)) break; // пусто ИЛИ уже был в этом цикле
            handledInCycle.add(item.id);

            statusEl.innerText = `Отправка: ${item.pointName} [${item.timestamp}]...`;

            try {
                await sendReportToServer(item);

                // Стирание с телефона — ТОЛЬКО после «success» от сервера.
                // Дубли на сервере исключены самой проверкой reportId.
                await dbDelete(item.id);

                const left = await dbCountActive();
                statusEl.innerText = left > 0
                    ? `Отправлено: ${item.pointName}. Осталось: ${left}.`
                    : `Отправлено: ${item.pointName}.`;

            } catch (err) {
                console.error('Сбой отправки:', err);

                // Диагностика пишется в отчет в любом случае
                item.retries = (item.retries || 0) + 1;
                item.lastError = err.message;
                if (err.permanent) item.failed = true; // откладываем «навсегда»

                try { await dbPut(item); } catch (dbErr) {}

                if (err.permanent) {
                    // ЯДОВИТАЯ ТАБЛЕТКА ИЗОЛИРОВАНА: не мешает очереди
                    statusEl.innerText = `Отчет «${item.pointName}» [${item.timestamp}] отложен — сервер его не принимает (${err.message}). Отчет сохранен в памяти, остальные отправляются дальше.`;
                    continue; // СЛЕДУЮЩИЙ отчет, а не break
                }

                statusEl.innerText = `Не отправлено: ${err.message}. Отчет остался в памяти телефона и отправится автоматически позже.`;
                break; // временная ошибка — ждем восстановления связи
            }
        }

        // Итоговая строка статуса. НОВОЕ: учитываем отложенные отдельно,
        // чтобы «Очередь пуста» не врала при наличии изолированных отчетов.
        const total = await dbCount();
        const active = await dbCountActive();
        if (active === 0) {
            statusEl.innerText = total > 0
                ? `Новые отчеты отправлены. Отложено из-за отказов сервера: ${total} (не блокируют работу).`
                : 'Все отчеты отправлены в таблицу! Очередь пуста.';
        }
    } catch (err) {
        // Ошибки самой базы (открытие/транзакция) — не улетают «в никуда»
        console.error('Критическая ошибка синхронизации:', err);
        statusEl.innerText = 'Ошибка базы данных: ' + err.message + '. Отчеты в безопасности — перезапустите приложение.';
    }
}

// ============================================================================
// БЛОК 7: СТАРТ ПРИЛОЖЕНИЯ
// ============================================================================
(async function init() {
    if (!('indexedDB' in window)) {
        statusEl.innerText = 'Браузер устарел и не поддерживает локальную базу. Обновите Chrome (Android) или Safari (iPhone).';
        return;
    }

    // Первичная проверка сети и очереди
    await updateStatusUI();
}());
