const GAS_URL = 'https://script.google.com/macros/s/AKfycbw7OGYLF9ZbKn00WQKljnaAVIv3lo_9pgEsn7mXtps1-6GDBW09clipa5P1-cpbQOMW/exec';

// Регистрация Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('SW не зарегистрирован:', err);
        });
    });
}

function getQueue() {
    try { return JSON.parse(localStorage.getItem('driver_queue') || '[]'); } 
    catch(e) { return []; }
}

function setQueue(q) {
    try { localStorage.setItem('driver_queue', JSON.stringify(q)); } 
    catch(e) { alert('Память переполнена! Срочно выгрузите отчеты при появлении сети.'); }
}

document.addEventListener('DOMContentLoaded', () => {
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
        if (!netStatusEl || !statusEl) return;

        if (navigator.onLine) {
            netStatusEl.className = 'badge online';
            netStatusEl.innerText = '● Подключение: Онлайн';
            if (q.length > 0) {
                statusEl.innerText = `В очереди: ${q.length} отчетов. Выгружаю...`;
                syncQueue();
            } else {
                statusEl.innerText = 'Готово к заполнению';
            }
        } else {
            netStatusEl.className = 'badge offline';
            netStatusEl.innerText = '○ Подключение: Офлайн (накопление)';
            statusEl.innerText = q.length > 0 
                ? `Офлайн. В памяти сохранено: ${q.length} отчетов` 
                : 'Офлайн. Отчет сохранится в память';
        }
    }

    window.addEventListener('online', updateStatusUI);
    window.addEventListener('offline', updateStatusUI);

    // ========================================================================
    // НАДЕЖНОЕ СЖАТИЕ ФОТО (Без зависания Promise)
    // ========================================================================
    function compressImage(file) {
        if (!file) return Promise.resolve(null);

        return new Promise((resolve) => {
            // Страховочный таймаут: если фото битое, не вешаем приложение
            const timer = setTimeout(() => {
                console.warn('Таймаут сжатия фото');
                resolve(null);
            }, 6000);

            const reader = new FileReader();
            reader.onerror = () => { clearTimeout(timer); resolve(null); };
            reader.onload = (e) => {
                const img = new Image();
                img.onerror = () => { clearTimeout(timer); resolve(null); };
                // ONLOAD СТРОГО ДО УСТАНОВКИ SRC:
                img.onload = () => {
                    clearTimeout(timer);
                    try {
                        const canvas = document.createElement('canvas');
                        const scale = img.width > 700 ? (700 / img.width) : 1;
                        canvas.width = Math.round(img.width * scale);
                        canvas.height = Math.round(img.height * scale);
                        
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        
                        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                        resolve(base64);
                    } catch (err) {
                        console.error('Ошибка canvas:', err);
                        resolve(null);
                    }
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
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

    // ========================================================================
    // ОДНОЭТАПНАЯ АТОМАРНАЯ ВЫГРУЗКА
    // ========================================================================
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

        const response = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });

        // Безопасное чтение ответа
        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            throw new Error('Google вернул не JSON: ' + text.substring(0, 100));
        }

        if (result.status === 'error') {
            throw new Error(result.message);
        }
    }

    // ========================================================================
    // ОБРАБОТЧИК КНОПКИ
    // ========================================================================
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
            console.error('Ошибка:', err);
            if (statusEl) statusEl.innerText = '❌ Ошибка: ' + err.message;
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', handleFormSubmit);
    }

    // ========================================================================
    // СИНХРОНИЗАЦИЯ ОЧЕРЕДИ
    // ========================================================================
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
                    // Удаляем только при подтвержденном успехе
                    q = getQueue().filter(x => x.id !== currentItem.id);
                    setQueue(q);
                    if (statusEl) statusEl.innerText = `✅ Отправлено: ${currentItem.pointName}!`;
                } catch (err) {
                    console.error("Сбой отправки:", err);
                    currentItem.retries = (currentItem.retries || 0) + 1;
                    
                    const curQ = getQueue();
                    const idx = curQ.findIndex(x => x.id === currentItem.id);
                    if (idx !== -1) {
                        if (currentItem.retries >= 3) {
                            curQ.splice(idx, 1); // Удаляем после 3 неудач
                        } else {
                            curQ[idx].retries = currentItem.retries;
                        }
                        setQueue(curQ);
                    }
                    if (statusEl) statusEl.innerText = `⚠️ Сбой сети: ${err.message}. Отчет сохранен в телефоне.`;
                    break;
                }
            }

            if (getQueue().length === 0 && statusEl) {
                statusEl.innerText = '✅ Все отчеты выгружены в таблицу!';
            }
        } finally {
            isSyncing = false;
        }
    }

    updateStatusUI();
});