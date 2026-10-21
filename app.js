/**
 * КЛИЕНТСКИЙ СКРИПТ PWA (v14)
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwljloq04eFUWElEXRBIz6g8HjZu2hqeoV1iR0VSZlDFP7ICCPFhX9w8odKl03XfGGK/exec';

// ============================================================================
// 1. УСТАНОВКА PWA И SERVICE WORKER
// ============================================================================
let deferredPrompt = null;
const installBtn = document.getElementById('installAppBtn');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.style.display = 'block';
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
            .catch((err) => console.error('Критический сбой регистрации SW:', err));
    });
}

// ============================================================================
// 2. ХРАНИЛИЩА (ОСНОВНАЯ ОЧЕРЕДЬ И АВАРИЙНЫЙ БУФЕР)
// ============================================================================
function getQueue() {
    try { return JSON.parse(localStorage.getItem('driver_queue') || '[]'); } 
    catch(e) { return []; }
}

function setQueue(q) {
    try { localStorage.setItem('driver_queue', JSON.stringify(q)); } 
    catch(e) { console.error('Ошибка LocalStorage (driver_queue):', e); }
}

// Буфер для отчетов, превысивших лимит попыток отправки
function getFailedQueue() {
    try { return JSON.parse(localStorage.getItem('driver_queue_failed') || '[]'); } 
    catch(e) { return []; }
}

function setFailedQueue(q) {
    try { localStorage.setItem('driver_queue_failed', JSON.stringify(q)); } 
    catch(e) { console.error('Ошибка LocalStorage (driver_queue_failed):', e); }
}

// ============================================================================
// 3. UI И ИНИЦИАЛИЗАЦИЯ
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    const uIn = document.getElementById('username');
    const statusEl = document.getElementById('status');
    const netStatusEl = document.getElementById('netStatus');
    const submitBtn = document.getElementById('submitBtn');
    const photoInput = document.getElementById('photo');
    const photoLabel = document.getElementById('photoFileName');
    const retryFailedBtn = document.getElementById('retryFailedBtn');

    if (uIn) {
        uIn.value = localStorage.getItem('drv') || '';
        uIn.oninput = () => localStorage.setItem('drv', uIn.value.trim());
    }

    if (photoInput && photoLabel) {
        photoInput.addEventListener('change', function() {
            if (this.files && this.files[0]) {
                photoLabel.style.display = 'block';
                photoLabel.innerText = '✅ Выбран файл: ' + this.files[0].name;
            } else {
                photoLabel.style.display = 'none';
            }
        });
    }

    function updateStatusUI() {
        const q = getQueue();
        const failedQ = getFailedQueue();

        // Отображение кнопки восстановления сбойных отчетов
        if (retryFailedBtn) {
            if (failedQ.length > 0) {
                retryFailedBtn.style.display = 'block';
                retryFailedBtn.innerText = `⚠️ Сбойных отчетов: ${failedQ.length}. Нажмите для повтора`;
            } else {
                retryFailedBtn.style.display = 'none';
            }
        }

        if (!netStatusEl || !statusEl) return;

        if (navigator.onLine) {
            netStatusEl.className = 'badge online';
            netStatusEl.innerText = '● Подключение: Онлайн';

            if (q.length > 0) {
                statusEl.innerText = `В очереди: ${q.length} отчетов. Выгружаю...`;
                syncQueue();
            } else if (failedQ.length === 0) {
                statusEl.innerText = 'Готово к заполнению';
            }
        } else {
            netStatusEl.className = 'badge offline';
            netStatusEl.innerText = '○ Подключение: Офлайн (накопление)';
            statusEl.innerText = q.length > 0 
                ? `Офлайн. В очереди: ${q.length} отчетов` 
                : 'Офлайн. Отчет сохранится в память';
        }
    }

    // Ручное восстановление сбойных отчетов из аварийного буфера
    if (retryFailedBtn) {
        retryFailedBtn.addEventListener('click', () => {
            const failedQ = getFailedQueue();
            if (failedQ.length === 0) return;

            const q = getQueue();
            // Возвращаем в очередь с обнулением счетчика попыток
            failedQ.forEach(item => {
                item.retries = 0;
                delete item.failedAt;
                delete item.lastError;
                q.push(item);
            });

            setQueue(q);
            setFailedQueue([]); // Очищаем аварийный буфер
            updateStatusUI();

            if (navigator.onLine) {
                syncQueue();
            } else {
                alert('Отчеты возвращены в очередь. Они выгрузятся при подключении к интернету.');
            }
        });
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
                console.warn('Таймаут сжатия фото');
                resolve(null);
            }, 6000);

            try {
                const blobUrl = URL.createObjectURL(file);
                const img = new Image();

                img.onerror = () => {
                    clearTimeout(timer);
                    URL.revokeObjectURL(blobUrl);
                    resolve(null);
                };

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

                        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                        resolve(base64 || null);
                    } catch (e) {
                        console.error('Ошибка canvas:', e);
                        resolve(null);
                    }
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
        if (photoLabel) photoLabel.style.display = 'none';
    }

    // ============================================================================
    // 5. ОТПРАВКА НА СЕРВЕР
    // ============================================================================
    async function sendReport(item) {
        const payload = {
            user: item.user,
            pointName: item.pointName,
            meter: item.meter,
            smallToys: item.smallToys,
            zamanukha: item.zamanukha,
            probros: item.probros,
            problems: item.problems,
            timestamp: item.timestamp,
            photoBase64: item.photoBase64
        };

        const res = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });

        const text = await res.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch(e) {
            throw new Error('Google вернул HTML вместо JSON (ошибка бэкенда)');
        }

        if (result.status === 'error') {
            throw new Error(result.message);
        }
    }

    // ============================================================================
    // 6. ОБРАБОТЧИК КНОПКИ
    // ============================================================================
    async function handleFormSubmit() {
        const user = (uIn ? uIn.value : '').trim();
        const pointEl = document.getElementById('pointName');
        const point = (pointEl ? pointEl.value : '').trim();

        if (!user) {
            alert('⚠️ Укажите ФИО водителя!');
            if (uIn) uIn.focus();
            return;
        }
        if (!point) {
            alert('⚠️ Заполните поле «1. Торговая точка»!');
            if (pointEl) pointEl.focus();
            return;
        }

        if (submitBtn) submitBtn.disabled = true;
        if (statusEl) statusEl.innerText = '⏳ Обработка и сжатие фото...';

        try {
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
                retries: 0
            };

            const q = getQueue();
            q.push(item);
            setQueue(q);
            
            clearForm();

            if (!navigator.onLine) {
                if (statusEl) statusEl.innerText = `✅ Сохранено в память (Офлайн). В очереди: ${q.length}`;
                return;
            }

            await syncQueue();

        } catch (err) {
            console.error('Ошибка сохранения:', err);
            if (statusEl) statusEl.innerText = '❌ Ошибка: ' + err.message;
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', handleFormSubmit);
    }

    // ============================================================================
    // 7. СИНХРОНИЗАТОР ОЧЕРЕДИ С ИЗОЛЯЦИЕЙ СБОЕВ
    // ============================================================================
    let isSyncing = false;

    async function syncQueue() {
        if (isSyncing || !navigator.onLine) return;
        isSyncing = true;

        try {
            let q = getQueue();

            while (q.length > 0 && navigator.onLine) {
                const currentItem = q[0];
                if (statusEl) statusEl.innerText = `Выгрузка: ${currentItem.pointName}...`;

                try {
                    await sendReport(currentItem);
                    
                    // Успех: удаляем отчет из памяти
                    q = getQueue().filter(x => x.id !== currentItem.id);
                    setQueue(q);
                    
                    if (statusEl) statusEl.innerText = `✅ Отправлено: ${currentItem.pointName}!`;
                } catch (err) {
                    console.error("Сбой выгрузки отчета:", err);
                    currentItem.retries = (currentItem.retries || 0) + 1;

                    const curQ = getQueue();
                    const idx = curQ.findIndex(x => x.id === currentItem.id);

                    if (idx !== -1) {
                        if (currentItem.retries >= 3) {
                            // ИЗОЛЯЦИЯ: НЕ УДАЛЯЕМ, а переносим в driver_queue_failed
                            const [failedItem] = curQ.splice(idx, 1);
                            failedItem.failedAt = new Date().toLocaleString('ru-RU');
                            failedItem.lastError = err.message || 'Ошибка сети/сервера';

                            const failedQ = getFailedQueue();
                            failedQ.push(failedItem);
                            setFailedQueue(failedQ);

                            if (statusEl) {
                                statusEl.innerText = `⚠️ Отчет «${failedItem.pointName}» не удалось отправить. Сохранен в сбойные.`;
                            }
                        } else {
                            curQ[idx].retries = currentItem.retries;
                            if (statusEl) {
                                statusEl.innerText = `⚠️ Сбой сети: ${err.message}. Попытка ${currentItem.retries}/3...`;
                            }
                        }
                        setQueue(curQ);
                    }
                    break;
                }
            }

            updateStatusUI();

            if (getQueue().length === 0 && getFailedQueue().length === 0 && statusEl) {
                statusEl.innerText = '✅ Все отчеты выгружены в таблицу!';
            }
        } finally {
            isSyncing = false;
        }
    }

    updateStatusUI();
});