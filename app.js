/**
 * КЛИЕНТСКИЙ СКРИПТ PWA-ПРИЛОЖЕНИЯ «ОТЧЕТ ЭКСПЕДИТОРА»
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbw6WZQQMcIa2UVuu1Gh7SUH9s-tvHukSzI8HslZl1f7yJfNYuVCj9HDou_rftoObsDD/exec';

// ============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ PWA И УСТАНОВКА
// ============================================================================

let deferredPrompt = null;
const installBtn = document.getElementById('installAppBtn');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) {
        installBtn.style.display = 'block';
    }
});

if (installBtn) {
    installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        installBtn.style.display = 'none';
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
    });
}

window.addEventListener('appinstalled', () => {
    if (installBtn) installBtn.style.display = 'none';
    deferredPrompt = null;
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then((reg) => console.log('SW зарегистрирован, scope:', reg.scope))
            .catch((err) => console.error('Ошибка SW:', err));
    });
}

// ============================================================================
// 2. РАБОТА С ХРАНИЛИЩЕМ (LOCALSTORAGE)
// ============================================================================

function getQueue() {
    try { 
        return JSON.parse(localStorage.getItem('driver_queue') || '[]'); 
    } catch(e) { 
        return []; 
    }
}

function setQueue(q) {
    try { 
        localStorage.setItem('driver_queue', JSON.stringify(q)); 
    } catch(e) { 
        console.error('Ошибка LocalStorage:', e);
    }
}

// ============================================================================
// 3. UI И СОСТОЯНИЕ СЕТИ
// ============================================================================

const uIn = document.getElementById('username');
const statusEl = document.getElementById('status');
const netStatusEl = document.getElementById('netStatus');
const submitBtn = document.getElementById('submitBtn');

if (uIn) {
    uIn.value = localStorage.getItem('drv') || '';
    uIn.oninput = () => localStorage.setItem('drv', uIn.value.trim());
}

function updateStatusUI() {
    const q = getQueue();

    if (navigator.onLine) {
        netStatusEl.className = 'badge online';
        netStatusEl.innerText = '● Подключение: Онлайн';

        if (q.length > 0) {
            statusEl.style.color = '#18181b';
            statusEl.innerText = `В очереди: ${q.length} отчетов. Выгружаю...`;
            syncQueue();
        } else {
            statusEl.style.color = '#18181b';
            statusEl.innerText = 'Готово к заполнению';
        }
    } else {
        netStatusEl.className = 'badge offline';
        netStatusEl.innerText = '○ Подключение: Офлайн (накопление)';
        statusEl.style.color = '#18181b';
        statusEl.innerText = q.length > 0 
            ? `Офлайн. В памяти: ${q.length} отчетов` 
            : 'Офлайн. Отчет сохранится в память';
    }
}

window.addEventListener('online', updateStatusUI);
window.addEventListener('offline', updateStatusUI);

// ============================================================================
// 4. СЖАТИЕ ФОТО (CANVAS)
// ============================================================================

function compressImage(file) {
    if (!file) return Promise.resolve(null);

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            console.warn('Таймаут сжатия');
            resolve(null);
        }, 5000);

        try {
            const blobUrl = URL.createObjectURL(file);
            const img = new Image();

            img.onload = () => {
                clearTimeout(timer);
                try {
                    URL.revokeObjectURL(blobUrl);
                    const canvas = document.createElement('canvas');
                    
                    const scale = img.width > 700 ? (700 / img.width) : 1;
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    resolve(canvas.toDataURL('image/jpeg', 0.5).split(',')[1]);
                } catch (e) {
                    console.error('Ошибка canvas:', e);
                    resolve(null);
                }
            };

            img.onerror = () => {
                clearTimeout(timer);
                URL.revokeObjectURL(blobUrl);
                resolve(null);
            };

            img.src = blobUrl;
        } catch (e) {
            clearTimeout(timer);
            resolve(null);
        }
    });
}

function clearForm() {
    ['pointName','meter','smallToys','zamanukha','probros','problems','photo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const photoLabel = document.getElementById('photoFileName');
    if (photoLabel) photoLabel.style.display = 'none';
}

// ============================================================================
// 5. ДВУХЭТАПНАЯ ВЫГРУЗКА
// ============================================================================

async function processTwoStep(item) {
    // Шаг 1: Текст
    if (!item.savedRow) {
        statusEl.innerText = `Отправка текста: ${item.pointName}...`;
        
        const textPayload = {
            action: 'TEXT',
            user: item.user,
            pointName: item.pointName,
            meter: item.meter,
            smallToys: item.smallToys,
            zamanukha: item.zamanukha,
            probros: item.probros,
            problems: item.problems,
            timestamp: item.timestamp,
            hasPhoto: !!item.photoBase64
        };

        const res1 = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(textPayload)
        });
        
        const data1 = await res1.json();
        if (data1.status === 'error') throw new Error(data1.message);

        item.savedRow = data1.row;
        item.sheetName = data1.sheetName;
        
        // Фиксируем полученный номер строки в памяти устройства
        const q = getQueue();
        const idx = q.findIndex(x => x.id === item.id);
        if (idx !== -1) { 
            q[idx] = item; 
            setQueue(q); 
        }
    }

    // Шаг 2: Фото
    if (item.photoBase64) {
        statusEl.innerText = `Загрузка фото на Google Диск...`;
        
        const photoPayload = {
            action: 'PHOTO',
            sheetName: item.sheetName,
            row: item.savedRow,
            photoBase64: item.photoBase64
        };

        const res2 = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(photoPayload)
        });
        
        const data2 = await res2.json();
        if (data2.status === 'error') throw new Error(data2.message);
    }
}

// ============================================================================
// 6. ОБРАБОТЧИК КНОПКИ (ЕДИНСТВЕННАЯ ТОЧКА ВХОДА)
// ============================================================================

async function handleFormSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();

    const user = (uIn ? uIn.value : '').trim();
    const pointEl = document.getElementById('pointName');
    const point = (pointEl ? pointEl.value : '').trim();

    if (!user) {
        statusEl.style.color = '#b91c1c';
        statusEl.innerText = '⚠️ Укажите ФИО водителя вверху!';
        if (uIn) uIn.focus();
        return;
    }
    if (!point) {
        statusEl.style.color = '#b91c1c';
        statusEl.innerText = '⚠️ Заполните поле «1. Торговая точка»!';
        if (pointEl) pointEl.focus();
        return;
    }

    submitBtn.disabled = true;
    statusEl.style.color = '#18181b';
    statusEl.innerText = '⏳ Обработка отчета...';

    try {
        const photoInput = document.getElementById('photo');
        const photoFile = (photoInput && photoInput.files) ? photoInput.files[0] : null;
        
        const photoBase64 = await compressImage(photoFile);
        const creationTime = new Date().toLocaleString('ru-RU');

        const item = {
            id: 'rep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            user: user,
            pointName: point,
            meter: (document.getElementById('meter')?.value || '').trim(),
            smallToys: (document.getElementById('smallToys')?.value || '').trim(),
            zamanukha: (document.getElementById('zamanukha')?.value || '').trim(),
            probros: (document.getElementById('probros')?.value || '').trim(),
            problems: (document.getElementById('problems')?.value || '').trim(),
            photoBase64: photoBase64,
            timestamp: creationTime,
            savedRow: null,
            sheetName: null,
            retries: 0
        };

        const q = getQueue();
        q.push(item);
        setQueue(q);
        
        clearForm();

        if (!navigator.onLine) {
            statusEl.style.color = '#166534';
            statusEl.innerText = `✅ Сохранено в память (Офлайн). В очереди: ${q.length}`;
            return;
        }

        await syncQueue();

    } catch (err) {
        console.error('Ошибка сохранения:', err);
        statusEl.style.color = '#b91c1c';
        statusEl.innerText = '❌ Ошибка: ' + err.message;
    } finally {
        submitBtn.disabled = false;
    }
}

// Привязываем обработчик события клика ТОЛЬКО ЗДЕСЬ
if (submitBtn) {
    submitBtn.addEventListener('click', handleFormSubmit);
}

// ============================================================================
// 7. СИНХРОНИЗАТОР ОЧЕРЕДИ (FIFO)
// ============================================================================

let isSyncing = false;

async function syncQueue() {
    if (isSyncing || !navigator.onLine) return;
    isSyncing = true;

    try {
        let q = getQueue();

        while (q.length > 0 && navigator.onLine) {
            const currentItem = q[0];

            try {
                await processTwoStep(currentItem);
                
                // Удаляем из памяти только при успешной отправке
                q = getQueue().filter(x => x.id !== currentItem.id);
                setQueue(q);
                
                statusEl.style.color = '#166534';
                statusEl.innerText = `✅ Отчет за [${currentItem.timestamp}] отправлен!`;
            } catch (err) {
                console.error("Сбой синхронизации:", err);
                currentItem.retries = (currentItem.retries || 0) + 1;

                const curQ = getQueue();
                const idx = curQ.findIndex(x => x.id === currentItem.id);
                if (idx !== -1) {
                    if (currentItem.retries >= 3) {
                        curQ.splice(idx, 1); // Удаляем битую запись
                    } else {
                        curQ[idx].retries = currentItem.retries;
                    }
                    setQueue(curQ);
                }
                
                statusEl.style.color = '#b91c1c';
                statusEl.innerText = `⚠️ Сбой отправки: ${err.message}. Сохранено в телефоне.`;
                break;
            }
        }

        if (getQueue().length === 0) {
            statusEl.style.color = '#166534';
            statusEl.innerText = '✅ Все отчеты выгружены в таблицу!';
        }
    } finally {
        isSyncing = false;
    }
}

// Запуск проверки при загрузке
updateStatusUI();