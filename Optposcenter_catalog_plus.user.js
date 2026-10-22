// ==UserScript==
// @name         optPOScenter: быстрый каталог и ЗИП
// @namespace    https://optposcenter.ru/
// @version      0.2.7
// @description  Быстрый поиск по каталогу, локальные позиции, заметки, связи с оборудованием и просмотр фото.
// @match        https://optposcenter.ru/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      www.youtube.com
// @connect      youtube.com
// @connect      rutube.ru
// @author       Jeronimo701
// @license      LicenseRef-Jeronimo701-Personal-Use-1.0
// @updateURL    none
// @homepageURL  https://github.com/jeronimo701/Optposcenter-catalog-plus
// ==/UserScript==

(function () {
    'use strict';

    const SETTINGS_KEY = 'optposcenter_catalog_plus_settings';
    const CUSTOM_ITEMS_KEY = 'optposcenter_catalog_plus_custom_items';
    const INDEX_KEY = 'optposcenter_catalog_plus_index';
    const INDEX_META_KEY = 'optposcenter_catalog_plus_index_meta';
    const PHOTO_AVAILABILITY_KEY = 'optposcenter_catalog_plus_photo_availability';
    const VIDEO_TITLE_CACHE_KEY = 'optposcenter_catalog_plus_video_title_cache';
    const EXPORT_FORM_URL = '/cab/catalog-export/?form=element&id=new';
    const INDEX_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const FETCH_RETRY_ATTEMPTS = 3;
    const FETCH_RETRY_DELAY_MS = 500;
    const MAX_CATALOG_PAGES = 300;
    const EMPTY_CATALOG_PAGE_LIMIT = 2;
    const CATALOG_PAGE_CONCURRENCY = 3;
    // If the portal changes column captions, update aliases here instead of parser code.
    const CATALOG_EXPORT_COLUMNS = Object.freeze({
        code: ['код 1с', 'код', 'артикул', 'номенклатура'],
        title: ['наименование', 'товар', 'название'],
        type: ['тип товара', 'тип'],
        vendor: ['производитель', 'бренд'],
        category: ['категория товара', 'категория', 'группа'],
    });
    // Keep portal markup dependencies in one place for easier maintenance.
    const CATALOG_PAGE_SELECTORS = Object.freeze({
        groupRow: 'tr.group_tr',
        productRow: 'tr[class^="tr_"]',
        productAnchor: '[id^="a_prod_"]',
        productMeta: '.prod_item_description',
        photoMarker: 'div, a, span',
    });
    const CARD_SELECTORS = Object.freeze({
        headings: 'p,h1,h2,h3,h4,h5,h6',
        tables: 'table',
        links: 'a[href]',
    });
    // The same section can be named slightly differently in older product cards.
    const CARD_SECTION_LABELS = Object.freeze({
        technical: ['Технические характеристики', 'Характеристики', 'Тех. характеристики'],
    });
    const DEFAULT_SETTINGS = { username: '', password: '', autoLogin: true };
    let searchTimer;
    let isIndexUpdating = false;
    let autoLoginAttempted = false;

    GM_registerMenuCommand('Настройки быстрого каталога', openSettings);
    GM_registerMenuCommand('Добавить локальную позицию', () => openItemEditor());
    GM_registerMenuCommand('Обновить индекс каталога', buildCatalogIndex);
    GM_registerMenuCommand('Экспортировать локальные позиции', exportCustomItems);
    GM_registerMenuCommand('Импортировать локальные позиции', importCustomItems);

    init();

    function init() {
        autoLogin();
        if (location.pathname.startsWith('/catalog')) {
            addCatalogToolbar();
            hideCatalogPromotion();
            enhanceProductRows();
        }
    }

    function hideCatalogPromotion() {
        if (location.pathname !== '/catalog/' || location.search) return;
        const style = document.createElement('style');
        style.id = 'opc-hide-catalog-promotion';
        style.textContent = [
            '.catalog_top',
            '.catalog_top .catalog_text',
            '.catalog_top .catalog_banner',
            '.catalog_top .owl-stage-outer',
            '.catalog_top .owl-controls',
        ].join(', ') + ' { display: none !important; }';
        if (!document.getElementById(style.id)) document.head.appendChild(style);
        const hide = () => document.querySelectorAll('.catalog_top, .catalog_top .catalog_text, .catalog_top .catalog_banner, .catalog_top .owl-stage-outer, .catalog_top .owl-controls')
            .forEach((promotion) => { promotion.style.setProperty('display', 'none', 'important'); });
        hide();
        new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true });
    }

    function getSettings() {
        return { ...DEFAULT_SETTINGS, ...(GM_getValue(SETTINGS_KEY, {}) || {}) };
    }

    function getIndex() {
        const index = GM_getValue(INDEX_KEY, []);
        return Array.isArray(index) ? index : [];
    }

    function getCustomItems() {
        const items = GM_getValue(CUSTOM_ITEMS_KEY, []);
        return Array.isArray(items) ? items : [];
    }

    function exportCustomItems() {
        const payload = {
            format: 'optposcenter-local-items',
            version: 1,
            exportedAt: new Date().toISOString(),
            items: getCustomItems(),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `optposcenter-local-items-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        showToast(`Экспортировано локальных позиций: ${payload.items.length}.`);
    }

    function importCustomItems() {
        const dialog = overlay();
        const box = modalBox('Импорт локальных позиций');
        box.innerHTML += `
            <label>Файл экспорта JSON<br><input data-field="import-file" type="file" accept="application/json,.json"></label>
            <div data-actions></div>`;
        const input = box.querySelector('[data-field="import-file"]');
        addAction(box, 'Импортировать', async () => {
            const file = input.files?.[0];
            if (!file) { showToast('Выберите JSON-файл для импорта.'); return; }
            await importCustomItemsFromFile(file);
            dialog.remove();
        }, true);
        addAction(box, 'Закрыть', () => dialog.remove());
        dialog.appendChild(box);
    }

    async function importCustomItemsFromFile(file) {
        try {
            const payload = JSON.parse(await file.text());
            if (payload?.format !== 'optposcenter-local-items' || !Array.isArray(payload.items)) {
                throw new Error('неверный файл локальных позиций');
            }
            const current = getCustomItems();
            const byKey = new Map(current.map((item) => [localItemKey(item), item]));
            const added = [];
            const updated = [];
            payload.items.filter((item) => item && item.title).forEach((item) => {
                const normalized = makeSearchableItem({
                    id: item.id || crypto.randomUUID(), code: String(item.code || ''), title: String(item.title || ''),
                    category: String(item.category || ''), equipment: String(item.equipment || ''),
                    note: String(item.note || ''), url: String(item.url || ''), custom: true,
                });
                const existing = byKey.get(localItemKey(normalized));
                if (existing) {
                    Object.assign(existing, normalized, { id: existing.id });
                    updated.push(normalized);
                } else {
                    current.push(normalized);
                    byKey.set(localItemKey(normalized), normalized);
                    added.push(normalized);
                }
            });
            GM_setValue(CUSTOM_ITEMS_KEY, current);
            refreshTypeFilter();
            showIndexStatus();
            const details = [
                ...added.map((item) => `Добавлено: ${localItemLabel(item)}`),
                ...updated.map((item) => `Обновлено: ${localItemLabel(item)}`),
            ];
            if (!added.length && !updated.length) {
                showImportResult('Импорт не выполнен', 'В файле не найдено новых или обновляемых локальных позиций.', [], 'danger');
            } else if (updated.length) {
                showImportResult('Импорт завершён с обновлениями', `Добавлено: ${added.length}. Обновлено по коду 1С: ${updated.length}. Проверьте изменения.`, details, 'warning');
            } else {
                showImportResult('Импорт выполнен', `Добавлено новых позиций: ${added.length}.`, details, 'success');
            }
        } catch (error) {
            showImportResult('Ошибка импорта', error.message, [], 'danger');
        }
    }

    function localItemLabel(item) {
        return `${item.code || 'Без кода'} - ${item.title || 'Без названия'}`;
    }

    function showImportResult(title, message, details, tone) {
        const dialog = overlay();
        const box = modalBox(title);
        const colors = {
            success: { background: '#dff3e5', border: '#8fc6a0', color: '#1d5a34' },
            warning: { background: '#fff4cc', border: '#ddbd67', color: '#6d4a00' },
            danger: { background: '#f9dede', border: '#d49a9a', color: '#7d2424' },
        };
        const color = colors[tone] || colors.danger;
        const messageBox = document.createElement('p');
        messageBox.textContent = message;
        Object.assign(messageBox.style, { margin: '12px 0 0', padding: '10px', border: `1px solid ${color.border}`, borderRadius: '5px', background: color.background, color: color.color, whiteSpace: 'pre-wrap' });
        const detailBox = document.createElement('div');
        detailBox.textContent = details.join('\n');
        Object.assign(detailBox.style, { display: details.length ? 'block' : 'none', maxHeight: '280px', overflowY: 'auto', marginTop: '10px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '5px', background: '#f8fafc', color: '#26384c', font: '13px Arial,sans-serif', lineHeight: '1.45', whiteSpace: 'pre-wrap' });
        const actions = document.createElement('div');
        actions.setAttribute('data-actions', '');
        box.append(messageBox, detailBox, actions);
        const ok = button('OK', () => dialog.remove(), tone);
        ok.style.marginTop = '16px';
        actions.appendChild(ok);
        dialog.appendChild(box);
    }

    function localItemKey(item) {
        const code = normalize(item.code);
        return code ? `code:${code}` : `title:${normalize(item.title)}`;
    }

    function autoLogin() {
        if (location.pathname.replace(/\/+$/, '') !== '/user/login') return;
        const settings = getSettings();
        if (!settings.autoLogin || !settings.username || !settings.password) return;
        const tryLogin = () => {
            if (autoLoginAttempted) return true;
            const form = document.querySelector('form#user-login, form[action*="/user/login"]');
            const loginInput = form?.querySelector('input[name="name"], input[name="login"], input[type="email"], input[type="text"]');
            const passwordInput = form?.querySelector('input[name="pass"], input[type="password"]');
            if (!form || !loginInput || !passwordInput) return false;
            autoLoginAttempted = true;
            loginInput.value = settings.username;
            passwordInput.value = settings.password;
            loginInput.dispatchEvent(new Event('input', { bubbles: true }));
            loginInput.dispatchEvent(new Event('change', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
            const submit = form.querySelector('button[type="submit"], input[type="submit"]');
            if (typeof form.requestSubmit === 'function') {
                form.requestSubmit(submit || undefined);
            } else {
                submit?.click();
            }
            return true;
        };
        if (tryLogin()) return;
        const observer = new MutationObserver(() => {
            if (tryLogin()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), 15000);
    }

    function openSettings() {
        const settings = getSettings();
        const dialog = overlay();
        const box = modalBox('Настройки быстрого каталога');
        box.innerHTML += `
            <label>Логин<br><input data-field="username" autocomplete="username"></label>
            <label>Пароль<br><input data-field="password" type="password" autocomplete="current-password"></label>
            <label style="display:block;margin-top:12px"><input data-field="auto" type="checkbox"> Входить автоматически на странице авторизации</label>
            <p style="color:#b7c3d0;font-size:12px">Данные хранятся локально в Tampermonkey для домена optposcenter.ru.</p>
            <div data-actions></div>`;
        const user = box.querySelector('[data-field="username"]');
        const password = box.querySelector('[data-field="password"]');
        user.value = settings.username;
        password.value = settings.password;
        box.querySelector('[data-field="auto"]').checked = settings.autoLogin;
        addAction(box, 'Сохранить', () => {
            GM_setValue(SETTINGS_KEY, { username: user.value.trim(), password: password.value, autoLogin: box.querySelector('[data-field="auto"]').checked });
            dialog.remove();
        }, true);
        addAction(box, 'Закрыть', () => dialog.remove());
        dialog.appendChild(box);
    }

    function addCatalogToolbar() {
        if (document.getElementById('opc-toolbar')) return;
        const anchor = document.querySelector('main h1') || document.querySelector('h1');
        if (!anchor) return;
        const bar = document.createElement('section');
        bar.id = 'opc-toolbar';
        bar.innerHTML = `<strong>Быстрый поиск:</strong><input placeholder="Название, код 1С, модель, оборудование или заметка"><select data-role="kind-filter"><option value="all">Все позиции</option><option value="spare">Только ЗИП</option><option value="equipment">Только оборудование</option><option value="custom">Локальные позиции</option></select><input data-role="type-filter" list="opc-type-filter-list" placeholder="Тип товара"><datalist id="opc-type-filter-list"></datalist><button data-action="add" title="Добавить локальную позицию">➕</button><button data-action="browser-index" title="Обновить индекс через страницы каталога">🔄</button><div data-role="status"></div><div data-role="results"></div>`;
        Object.assign(bar.style, { position: 'relative', margin: '16px 0', padding: '14px', border: '1px solid #c8d2df', borderRadius: '6px', background: '#f4f7fb', color: '#17212d' });
        const input = bar.querySelector('input');
        Object.assign(input.style, { width: 'min(450px, 100%)', margin: '0 8px', padding: '8px' });
        bar.querySelectorAll('select, [data-role="type-filter"]').forEach((control) => Object.assign(control.style, { margin: '4px', padding: '8px', maxWidth: '220px' }));
        styleButton(bar.querySelector('[data-action="add"]'), 'success');
        styleButton(bar.querySelector('[data-action="browser-index"]'), 'warning');
        bar.querySelectorAll('button').forEach((buttonElement) => { buttonElement.style.margin = '4px'; });
        bar.querySelector('[data-action="add"]').onclick = () => openItemEditor(null, () => runSearch(input.value));
        bar.querySelector('[data-action="browser-index"]').onclick = buildCatalogIndexFromBrowser;
        input.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => runSearch(input.value), 120);
        });
        bar.querySelector('[data-role="kind-filter"]').addEventListener('change', () => runSearch(input.value));
        bar.querySelector('[data-role="type-filter"]').addEventListener('input', () => runSearch(input.value));
        anchor.insertAdjacentElement('afterend', bar);
        refreshTypeFilter();
        showIndexStatus();
        updateIndexIfStale();
        keepQuickSearchInView();
    }

    function keepQuickSearchInView() {
        // The catalog restores its own scroll position after loading. Repeat briefly to keep the search panel visible.
        [0, 250, 800, 1500].forEach((delay) => setTimeout(() => {
            const heading = document.querySelector('main h1') || document.querySelector('h1');
            if (heading) heading.scrollIntoView({ block: 'start', behavior: 'auto' });
        }, delay));
    }

    function showIndexStatus(text) {
        const status = document.querySelector('#opc-toolbar [data-role="status"]');
        if (!status) return;
        const meta = GM_getValue(INDEX_META_KEY, {});
        status.textContent = text || `Индекс: ${getIndex().length} позиций, локальных: ${getCustomItems().length}${meta.updatedAt ? `, обновлён ${new Date(meta.updatedAt).toLocaleString('ru-RU')}` : ''}`;
        status.style.margin = '8px 0 0';
        status.style.display = 'block';
        status.style.fontSize = '12px';
    }

    function updateIndexIfStale() {
        const meta = GM_getValue(INDEX_META_KEY, {});
        const isStale = !meta.updatedAt || Date.now() - meta.updatedAt >= INDEX_UPDATE_INTERVAL_MS;
        if (isStale) buildCatalogIndex();
    }

    function normalize(value) {
        return String(value || '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
    }

    function makeSearchableItem(item) {
        const searchText = normalize([item.code, item.title, item.type, item.vendor, item.category, item.group, item.equipment, item.note].join(' '));
        return {
            ...item,
            searchText,
            searchCompact: searchText.replace(/\s+/g, ''),
            searchCode: normalize(item.code),
            searchTitle: normalize(item.title),
        };
    }

    // Модели часто набирают в неверной раскладке: «л320» вместо «k320».
    // Вариант нужен только для поиска; названия позиций в базе не изменяются.
    function keyboardLayoutVariant(value) {
        const ruToEn = { й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p', х: '[', ъ: ']', ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l', ж: ';', э: "'", я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm', б: ',', ю: '.' };
        return [...String(value || '').toLocaleLowerCase('ru')].map((symbol) => ruToEn[symbol] || symbol).join('');
    }

    function scoreItem(item, query) {
        const searchItem = item.searchText ? item : makeSearchableItem(item);
        const haystack = searchItem.searchText;
        const rawWords = normalize(query).split(' ').filter(Boolean);
        // A short revision marker such as "2" in "Atlas-2" is not always present
        // in the export title. Keep it optional when a model name is also provided.
        const hasModelWords = rawWords.some((word) => !/^\d{1,2}$/.test(word));
        const words = rawWords.filter((word) => !hasModelWords || !/^\d{1,2}$/.test(word));
        if (!words.length) return 0;
        let score = 0;
        const compactQuery = rawWords.join('');
        const compactHaystack = searchItem.searchCompact;
        for (const word of words) {
            const alternatives = [word, normalize(keyboardLayoutVariant(word))].filter(Boolean);
            const matchedWord = alternatives.find((alternative) => haystack.includes(alternative));
            const at = matchedWord ? haystack.indexOf(matchedWord) : -1;
            if (at < 0) return -1;
            score += at === 0 ? 30 : 10;
            if (searchItem.searchCode === word) score += 100;
            if (searchItem.searchTitle.startsWith(word)) score += 40;
        }
        // Model variants are often written as Atlas-2, Atlas 2 or Atlas2.
        // A compact exact fragment ranks that model above broad matches for Atlas.
        if (compactQuery.length >= 4 && compactHaystack.includes(compactQuery)) score += 150;
        return score;
    }

    function runSearch(query) {
        const results = document.querySelector('#opc-toolbar [data-role="results"]');
        if (!results) return;
        results.replaceChildren();
        results.style.maxHeight = '';
        results.style.overflowY = '';
        results.style.paddingRight = '';
        const typeFilter = document.querySelector('#opc-toolbar [data-role="type-filter"]')?.value || '';
        const kindFilter = document.querySelector('#opc-toolbar [data-role="kind-filter"]')?.value || 'all';
        const hasQuery = Boolean(normalize(query));
        if (!hasQuery && !typeFilter && kindFilter === 'all') return;
        const all = [...getCustomItems().map((item) => ({ ...item, custom: true })), ...getIndex()];
        const found = all.filter((item) => matchesCatalogFilters(item, typeFilter, kindFilter))
            .map((item) => ({ item, score: scoreItem(item, query) }))
            .filter((item) => item.score >= 0).sort((a, b) => b.score - a.score).slice(0, 100);
        if (!found.length) {
            results.textContent = 'Ничего не найдено. Можно добавить локальную позицию.';
            return;
        }
        if (found.length > 20) {
            results.style.maxHeight = 'min(880px, calc(100vh - 250px))';
            results.style.overflowY = 'auto';
            results.style.paddingRight = '8px';
        }
        const summary = document.createElement('div');
        summary.textContent = `Найдено позиций: ${found.length}${found.length === 100 ? ' (показаны первые 100)' : ''}`;
        summary.style.cssText = 'margin:8px 0 4px;color:#58687a;font-size:12px';
        results.appendChild(summary);
        const groups = new Map();
        found.forEach(({ item }) => {
            const key = item.custom ? 'Локальные позиции' : (item.category || item.group || item.type || 'Без категории');
            groups.set(key, [...(groups.get(key) || []), item]);
        });
        groups.forEach((items, group) => {
            const section = document.createElement('section');
            section.style.cssText = 'margin-top:10px';
            const heading = document.createElement('button');
            heading.type = 'button';
            heading.setAttribute('aria-expanded', 'true');
            heading.innerHTML = `<span data-role="arrow">▾</span> ${escapeHtml(group)} <small>(${items.length})</small>`;
            heading.style.cssText = 'display:block;width:100%;padding:6px 4px;border:0;border-bottom:1px solid #c6d1df;background:transparent;color:#17212d;text-align:left;font-weight:700;cursor:pointer';
            const body = document.createElement('div');
            items.forEach((item) => body.appendChild(renderSearchItem(item, query)));
            heading.addEventListener('click', () => {
                const expanded = heading.getAttribute('aria-expanded') === 'true';
                heading.setAttribute('aria-expanded', String(!expanded));
                heading.querySelector('[data-role="arrow"]').textContent = expanded ? '▸' : '▾';
                body.hidden = expanded;
            });
            section.append(heading, body);
            results.appendChild(section);
        });
    }

    function isSparePart(item) {
        return /зип/i.test(item.category || '');
    }

    function matchesCatalogFilters(item, typeFilter, kindFilter) {
        if (typeFilter && !normalize(item.type).includes(normalize(typeFilter))) return false;
        if (kindFilter === 'custom') return Boolean(item.custom);
        if (kindFilter === 'spare') return !item.custom && isSparePart(item);
        if (kindFilter === 'equipment') return !item.custom && !isSparePart(item);
        return true;
    }

    function refreshTypeFilter() {
        const list = document.querySelector('#opc-type-filter-list');
        if (!list) return;
        const types = [...new Set([...getIndex(), ...getCustomItems()].map((item) => item.type).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right, 'ru'));
        list.replaceChildren();
        types.forEach((type) => list.appendChild(new Option(type)));
    }

    function getEquipmentOptions() {
        const catalogEquipment = getIndex()
            // The equipment link must not suggest spare parts, even if their title contains a model name.
            .filter((item) => item.category && !isSparePart(item))
            .map((item) => item.title)
            .filter(Boolean);
        const linkedEquipment = getCustomItems().filter((item) => !isSparePart(item)).map((item) => item.equipment).filter(Boolean);
        return [...new Set([...catalogEquipment, ...linkedEquipment])]
            .sort((left, right) => left.localeCompare(right, 'ru'));
    }

    function renderSearchItem(item, query) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 4px;border-top:1px solid #d8e0ea';
        const text = document.createElement('div');
        text.style.flex = '1';
        text.innerHTML = `<b>${highlightMatches(item.code || 'Локально', query)}</b>, ${highlightMatches(cleanItemTitle(item.title), query)}${item.equipment ? `<br><small>Оборудование: ${highlightMatches(item.equipment, query)}</small>` : ''}${item.note ? `<br><small>Заметка: ${highlightMatches(item.note, query)}</small>` : ''}`;
        row.appendChild(text);
        if (item.productId) row.appendChild(createPhotoButton(item.productId, item.hasPhotosHint));
        if (item.productId) {
            const openButton = button('↗', () => openProductCard(item.productId, item), 'primary', 'Открыть читаемую карточку товара');
            row.appendChild(openButton);
        } else if (item.url) {
            const openButton = button('↗', () => window.open(item.url, '_blank', 'noopener'), 'primary', 'Открыть карточку товара');
            row.appendChild(openButton);
        }
        row.appendChild(button('📝', () => openItemEditor(item), 'neutral', item.custom ? 'Изменить локальную позицию' : 'Добавить заметку к позиции'));
        row.appendChild(button('📋', () => copyItemSummary(item), 'neutral', 'Копировать код 1С и наименование'));
        return row;
    }

    function cleanItemTitle(value) {
        return String(value || '').replace(/\s+Тип\s*:\s*[\s\S]*$/i, '').trim();
    }

    function getPhotoAvailability() {
        return GM_getValue(PHOTO_AVAILABILITY_KEY, {}) || {};
    }

    function createPhotoButton(productId, hasPhotosHint = false) {
        const availability = getPhotoAvailability();
        const buttonElement = button('🖼️', () => handlePhotoClick(buttonElement, productId), 'info', 'Открыть фото товара');
        const isKnown = Object.prototype.hasOwnProperty.call(availability, productId);
        updatePhotoButton(buttonElement, isKnown ? availability[productId] : hasPhotosHint);
        return buttonElement;
    }

    async function handlePhotoClick(buttonElement, productId) {
        const availability = getPhotoAvailability();
        if (availability[productId] === false) {
            showToast('В карточке товара нет изображений.');
            return;
        }
        if (availability[productId] === true) {
            openPhotos(productId);
            return;
        }
        buttonElement.textContent = 'Проверка...';
        buttonElement.disabled = true;
        const hasPhotos = await checkProductPhotos(productId);
        if (hasPhotos === null) {
            updatePhotoButton(buttonElement, false);
            showToast('Не удалось проверить наличие фото.');
            return;
        }
        updatePhotoButton(buttonElement, hasPhotos);
        if (hasPhotos) openPhotos(productId);
        else showToast('В карточке товара нет изображений.');
    }

    function updatePhotoButton(buttonElement, hasPhotos) {
        buttonElement.disabled = false;
        if (hasPhotos) {
            buttonElement.textContent = '🖼️';
            styleButton(buttonElement, 'info');
            buttonElement.style.textDecoration = '';
            buttonElement.title = 'Открыть фото товара';
        } else {
            buttonElement.textContent = '🖼️';
            styleButton(buttonElement, 'danger');
            buttonElement.style.textDecoration = 'line-through';
            buttonElement.title = 'В карточке товара нет изображений';
        }
    }

    async function copyItemSummary(item) {
        const summary = `${item.code || 'Без кода'}, ${cleanItemTitle(item.title)}`.trim();
        try {
            await navigator.clipboard.writeText(summary);
        } catch (error) {
            const field = document.createElement('textarea');
            field.value = summary;
            document.body.appendChild(field);
            field.select();
            document.execCommand('copy');
            field.remove();
        }
    }

    async function checkProductPhotos(productId) {
        try {
            const html = await fetch(`/?q=ajax_get_prod_card&id=${encodeURIComponent(productId)}`).then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            });
            const hasPhotos = extractCardImages(new DOMParser().parseFromString(html, 'text/html')).length > 0;
            const availability = getPhotoAvailability();
            availability[productId] = hasPhotos;
            GM_setValue(PHOTO_AVAILABILITY_KEY, availability);
            return hasPhotos;
        } catch (error) {
            console.warn(`Не удалось проверить фото товара ${productId}`, error);
            return null;
        }
    }

    function highlightMatches(value, query) {
        const source = String(value || '');
        const words = normalize(query).split(' ').filter(Boolean);
        if (!words.length) return escapeHtml(source);
        const variants = [...new Set(words.flatMap((word) => [word, normalize(keyboardLayoutVariant(word))]).filter(Boolean))]
            .sort((left, right) => right.length - left.length);
        const expression = new RegExp(`(${variants.map(escapeRegExp).join('|')})`, 'gi');
        return escapeHtml(source).replace(expression, '<mark style="background:#ffe082;color:#17212d;padding:0 1px;border-radius:2px">$1</mark>');
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function enhanceProductRows() {
        document.querySelectorAll('tr[class^="tr_"]').forEach((row) => {
            if (row.dataset.opcEnhanced) return;
            row.dataset.opcEnhanced = '1';
            const productId = row.querySelector('[id^="a_prod_"]')?.id.replace('a_prod_', '');
            const photoLabel = [...row.querySelectorAll('div')].find((item) => item.textContent.trim() === 'фото');
            if (photoLabel && productId) {
                photoLabel.onclick = (event) => { event.preventDefault(); event.stopPropagation(); openPhotos(productId); };
                photoLabel.title = 'Открыть фото в просмотрщике';
            }
        });
    }

    async function buildCatalogIndex() {
        if (isIndexUpdating) {
            showIndexStatus('Обновление индекса уже выполняется...');
            return;
        }
        isIndexUpdating = true;
        const status = (text) => showIndexStatus(text);
        try {
            status('Обновление: получение Excel (0%)...');
            try {
                await assertAuthorized();
                const exportResult = await downloadCatalogExport();
                status('Обновление: обработка Excel (60%)...');
                const items = exportResult.items;
                GM_setValue(INDEX_KEY, uniqueBy(items, (item) => item.productId || item.code || item.title));
                GM_setValue(INDEX_META_KEY, { updatedAt: Date.now(), source: exportResult.exportType.toUpperCase() });
                GM_setValue(PHOTO_AVAILABILITY_KEY, {});
                refreshTypeFilter();
                status(`Обновление завершено: ${exportResult.exportType.toUpperCase()}, ${items.length} позиций (100%)`);
                return;
            } catch (error) {
                console.warn('Не удалось построить индекс из Excel, используется резервный обход каталога.', error);
                status(`Не удалось загрузить Excel: ${error.message}. Перехожу к обновлению через браузер...`);
                await new Promise((resolve) => setTimeout(resolve, 1200));
            }

            await buildCatalogIndexFromBrowser(true);
        } catch (error) {
            status(`Ошибка обновления индекса: ${error.message}`);
        } finally {
            isIndexUpdating = false;
        }
    }

    async function downloadCatalogExport() {
        const formHtml = await fetchText(EXPORT_FORM_URL, 'форма экспорта');
        const documentCopy = new DOMParser().parseFromString(formHtml, 'text/html');
        const form = documentCopy.querySelector('form.objform');
        if (!form) throw new Error('на странице экспорта не найдена форма скачивания');

        const action = new URL(form.getAttribute('action') || EXPORT_FORM_URL, location.origin);
        const errors = [];
        for (const exportType of ['xlsx', 'htmlxls', 'html']) {
            try {
                const values = new FormData(form);
                // Полный каталог: не передаём фильтр наличия и необязательные ценовые колонки.
                ['only_stocks', 'only_fix_prices', 'col_price1', 'col_price2', 'col_stocks'].forEach((name) => values.delete(name));
                values.set('act', 'save');
                values.set('export_type', exportType);
                const response = await fetchWithRetry(action, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams(values).toString(),
                }, `выгрузка ${exportType.toUpperCase()}`);
                const data = await response.arrayBuffer();
                const workbook = readCatalogWorkbook(data);
                const items = parseCatalogExport(workbook);
                if (!items.length) throw new Error('не найдены товарные строки');
                return { exportType, items };
            } catch (error) {
                errors.push(`${exportType}: ${error.message}`);
            }
        }
        throw new Error(`не удалось разобрать выгрузку (${errors.join('; ')})`);
    }

    function readCatalogWorkbook(data) {
        const beginning = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(data.byteLength, 512))).trimStart();
        if (/^<(?:!doctype|html|head|body|table)\b/i.test(beginning)) {
            return XLSX.read(new TextDecoder().decode(data), { type: 'string' });
        }
        return XLSX.read(data, { type: 'array' });
    }

    async function buildCatalogIndexFromBrowser(fromExcelFallback = false) {
        if (isIndexUpdating && !fromExcelFallback) {
            showIndexStatus('Обновление индекса уже выполняется...');
            return;
        }
        if (!fromExcelFallback) isIndexUpdating = true;
        const status = (text) => showIndexStatus(text);
        // Резервный источник: позиции читаются непосредственно со страниц каталога.
        const items = [];
        let emptyPages = 0;
        const seenProductIds = new Set();
        try {
            for (let page = 0; page < MAX_CATALOG_PAGES && emptyPages < EMPTY_CATALOG_PAGE_LIMIT; page += CATALOG_PAGE_CONCURRENCY) {
                const pageNumbers = Array.from(
                    { length: Math.min(CATALOG_PAGE_CONCURRENCY, MAX_CATALOG_PAGES - page) },
                    (_, index) => page + index,
                );
                status(`Обновление через браузер: страницы ${pageNumbers[0] + 1}-${pageNumbers.at(-1) + 1}, найдено ${items.length} позиций...`);
                const pageResults = await Promise.all(pageNumbers.map(async (pageNumber) => {
                    const label = `страница каталога ${pageNumber + 1}`;
                    const html = await fetchText(`/catalog?page=${pageNumber}`, label);
                    assertNotAuthorizationPage(html, label);
                    return parseCatalogPage(html);
                }));
                for (const pageItems of pageResults) {
                    const newItems = pageItems.filter((item) => {
                        if (seenProductIds.has(item.productId)) return false;
                        seenProductIds.add(item.productId);
                        return true;
                    });
                    if (newItems.length) {
                        items.push(...newItems);
                        emptyPages = 0;
                    } else {
                        // После последней страницы портал иногда повторяет последнюю, а не отдаёт пустой список.
                        emptyPages += 1;
                    }
                    if (emptyPages >= EMPTY_CATALOG_PAGE_LIMIT) break;
                }
                await new Promise((resolve) => setTimeout(resolve, 70));
            }
            if (!items.length) throw new Error('на страницах каталога не найдены товарные позиции');
            GM_setValue(INDEX_KEY, uniqueBy(items, (item) => item.productId || item.code));
            GM_setValue(INDEX_META_KEY, { updatedAt: Date.now(), source: 'Браузер' });
            GM_setValue(PHOTO_AVAILABILITY_KEY, {});
            refreshTypeFilter();
            status(`Обновление завершено: браузер, ${items.length} позиций (100%)`);
        } catch (error) {
            status(`Ошибка обновления индекса: ${error.message}`);
        } finally {
            if (!fromExcelFallback) isIndexUpdating = false;
        }
    }

    async function assertAuthorized() {
        const html = await fetchText(EXPORT_FORM_URL, 'проверка авторизации');
        assertNotAuthorizationPage(html, 'проверка авторизации');
        if (!new DOMParser().parseFromString(html, 'text/html').querySelector('form.objform')) {
            throw new Error('не удалось подтвердить доступ к выгрузке. Войдите в личный кабинет и повторите обновление');
        }
    }

    function assertNotAuthorizationPage(html, source) {
        const documentCopy = new DOMParser().parseFromString(html, 'text/html');
        const text = documentCopy.body?.innerText || documentCopy.body?.textContent || '';
        if (documentCopy.querySelector('#edit-name, input[name="name"], input[type="password"]')
            || /войти|авторизац|необходима авторизация|доступ к этой странице/i.test(text)) {
            throw new Error(`${source}: требуется авторизация на портале`);
        }
    }

    async function fetchText(url, label) {
        const response = await fetchWithRetry(url, undefined, label);
        return response.text();
    }

    async function fetchWithRetry(url, options, label = 'запрос') {
        let lastError;
        for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt += 1) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response;
            } catch (error) {
                lastError = error;
                if (attempt < FETCH_RETRY_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * 2 ** (attempt - 1)));
                }
            }
        }
        throw new Error(`${label}: не удалось выполнить запрос после ${FETCH_RETRY_ATTEMPTS} попыток (${lastError.message})`);
    }

    function parseCatalogExport(workbook) {
        const items = [];
        workbook.SheetNames.forEach((sheetName) => {
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
            rows.forEach((row) => {
                const values = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalize(key), String(value || '').trim()]));
                const code = pickColumn(values, CATALOG_EXPORT_COLUMNS.code);
                const title = pickColumn(values, CATALOG_EXPORT_COLUMNS.title);
                if (!title) return;
                items.push(makeSearchableItem({
                    code,
                    title,
                    type: pickColumn(values, CATALOG_EXPORT_COLUMNS.type),
                    vendor: pickColumn(values, CATALOG_EXPORT_COLUMNS.vendor),
                    category: pickColumn(values, CATALOG_EXPORT_COLUMNS.category),
                    group: sheetName,
                    productId: '',
                    url: '',
                }));
            });
        });
        return items;
    }

    function pickColumn(values, names) {
        for (const name of names) {
            const exact = values[normalize(name)];
            if (exact) return exact;
            const similarKey = Object.keys(values).find((key) => key.includes(normalize(name)) || normalize(name).includes(key));
            if (similarKey && values[similarKey]) return values[similarKey];
        }
        return '';
    }

    function parseCatalogPage(html) {
        const documentCopy = new DOMParser().parseFromString(html, 'text/html');
        let currentGroup = '';
        return [...documentCopy.querySelectorAll('tr')].map((row) => {
            if (row.matches(CATALOG_PAGE_SELECTORS.groupRow)) {
                currentGroup = row.innerText.replace(/\s+/g, ' ').trim();
                return null;
            }
            if (!row.matches(CATALOG_PAGE_SELECTORS.productRow)) {
                return null;
            }
            const cells = row.querySelectorAll('td');
            const productId = row.querySelector(CATALOG_PAGE_SELECTORS.productAnchor)?.id.replace('a_prod_', '') || '';
            const description = cleanItemTitle(cells[1]?.innerText.replace(/^\s*фото\s*/i, '').replace(/\s+/g, ' ').trim() || '');
            const meta = cells[1]?.querySelector(CATALOG_PAGE_SELECTORS.productMeta)?.innerText || '';
            const type = /Тип:\s*([^\n]+?)(?=\s*Производитель:|$)/i.exec(meta)?.[1]?.trim() || '';
            const vendor = /Производитель:\s*([^\n]+)/i.exec(meta)?.[1]?.trim() || '';
            const hasPhotosHint = [...cells[1]?.querySelectorAll(CATALOG_PAGE_SELECTORS.photoMarker) || []]
                .some((element) => element.textContent.trim().toLowerCase() === 'фото');
            return makeSearchableItem({ productId, code: cells[0]?.innerText.trim() || '', title: description, type, vendor, category: currentGroup, group: currentGroup, hasPhotosHint, url: productId ? `/?q=ajax_get_prod_card&id=${productId}` : '' });
        }).filter((item) => item?.productId && item.title);
    }

    async function openProductCard(productId, item) {
        const dialog = overlay();
        const box = modalBox('Карточка товара');
        Object.assign(box.style, { width: '980px', maxWidth: 'calc(100% - 32px)', maxHeight: 'calc(100% - 36px)', padding: '20px' });
        box.innerHTML = '<div style="color:#64748b">Загрузка карточки...</div>';
        dialog.appendChild(box);

        const close = () => {
            dialog.remove();
            window.removeEventListener('keydown', onKeyDown);
        };
        const onKeyDown = (event) => { if (event.key === 'Escape') close(); };
        window.addEventListener('keydown', onKeyDown);

        try {
            const response = await fetch(`/?q=ajax_get_prod_card&id=${encodeURIComponent(productId)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const card = new DOMParser().parseFromString(await response.text(), 'text/html');
            const cardText = card.body.innerText || card.body.textContent || '';
            if (card.querySelector('#edit-name, #edit-pass') || /Для доступа к этому разделу необходима авторизация/i.test(cardText)) {
                close();
                showToast('Не удалось получить карточку: требуется авторизация на портале.', 'warning');
                window.open(item.url || `/?q=ajax_get_prod_card&id=${encodeURIComponent(productId)}`, '_blank', 'noopener');
                return;
            }
            renderProductCard(box, card, item, productId, close);
        } catch (error) {
            box.innerHTML = '';
            const message = document.createElement('p');
            message.textContent = `Не удалось загрузить карточку: ${error.message}`;
            box.appendChild(message);
            const actions = document.createElement('div');
            actions.append(
                button('Открыть на сайте', () => window.open(item.url || `/?q=ajax_get_prod_card&id=${encodeURIComponent(productId)}`, '_blank', 'noopener'), 'primary'),
                button('Закрыть', close),
            );
            box.appendChild(actions);
        }
    }

    function renderProductCard(box, card, item, productId, close) {
        const cardText = card.body.innerText || card.body.textContent || '';
        const lines = cardText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const title = findCardValue(lines, 'Наименование:') || cleanItemTitle(item.title) || 'Карточка товара';
        const category = lines[0] && !/^Наименование:/i.test(lines[0]) ? lines[0] : '';
        const manufacturer = findCardValue(lines, 'Производитель:');
        const description = extractCardDescription(card) || textBetweenLabels(lines, 'Описание:', ['Технические характеристики:', 'Комплектация', 'Изображение', 'Видео']);
        const tables = extractCardTables(card);
        const links = extractCardLinks(card);
        const images = extractCardImages(card);
        const videoLinks = links.filter((link) => isVideoLink(link) || /^видео$/i.test(link.name));
        videoLinks.forEach((link, index) => { link.name = getVideoLabel(link, index + 1); });
        const fileLinks = links.filter((link) => isFileLink(link) && !isVideoLink(link));
        const documentationLinks = fileLinks.filter((link) => isDocumentationLink(link));
        const archiveLinks = fileLinks.filter((link) => !documentationLinks.includes(link));
        const otherLinks = links.filter((link) => !videoLinks.includes(link) && !fileLinks.includes(link) && !isImageLink(link));

        box.innerHTML = '';
        const heading = document.createElement('h2');
        heading.textContent = title;
        heading.style.cssText = 'margin:0 40px 6px 0;font-size:20px;line-height:1.3;color:#17212d';
        const closeButton = button('Закрыть', close, 'neutral', 'Закрыть карточку (Esc)');
        closeButton.style.cssText += ';position:absolute;right:20px;top:18px';
        box.style.position = 'relative';
        box.append(heading, closeButton);

        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px 18px;margin:0 0 14px;color:#475569';
        [[`Код 1С: ${item.code}`, item.code], ['Категория: ' + category, category], ['Производитель: ' + manufacturer, manufacturer]]
            .filter(([, value]) => value)
            .forEach(([text]) => {
                const chip = document.createElement('span');
                chip.textContent = text;
                chip.style.cssText = 'padding:4px 8px;background:#eef3f8;border:1px solid #d6e0ea;border-radius:4px';
                meta.appendChild(chip);
            });
        if (meta.childElementCount) box.appendChild(meta);

        const descriptionTables = tables.filter((table) => table.inDescription);
        const specificationTables = tables.filter((table) => !table.inDescription);
        if (description || descriptionTables.length) box.appendChild(createCardSection('Описание', createDescriptionContent(description, descriptionTables)));
        if (specificationTables.length) {
            specificationTables.filter((table) => table.title).forEach((table) => {
                const label = table.title;
                box.appendChild(createCardSection(label, createFactsTable(table.rows)));
            });
            const untitledTables = specificationTables.filter((table) => !table.title);
            if (untitledTables.length) box.appendChild(createCardSection('Дополнительные данные', createTableCollection(untitledTables)));
        } else {
            const technicalText = textBetweenLabels(lines, 'Технические характеристики:', ['Комплектация', 'Изображение', 'Видео']);
            if (technicalText) box.appendChild(createCardSection('Технические характеристики', createTextBlock(technicalText)));
        }
        if (videoLinks.length) box.appendChild(createCardSection('Видео', createVideoLinkList(videoLinks)));
        if (archiveLinks.length) box.appendChild(createCardSection('Архивы и прочие файлы', createLinkList(archiveLinks, true)));
        if (otherLinks.length) box.appendChild(createCardSection('Ссылки', createLinkList(otherLinks)));
        if (images.length) box.appendChild(createCardSection('Фото', createPhotoGrid(images, productId), true));
        if (documentationLinks.length) box.appendChild(createCardSection('Документация', createLinkList(documentationLinks, true), true));
        if (!description && !tables.length && !images.length && !videoLinks.length && !fileLinks.length) {
            box.appendChild(createCardSection('Данные карточки', createTextBlock(cardText)));
        }
    }

    function findCardValue(lines, label) {
        const index = lines.findIndex((line) => line.toLowerCase().startsWith(label.toLowerCase()));
        return index === -1 ? '' : lines[index].slice(label.length).trim();
    }

    function textBetweenLabels(lines, startLabel, endLabels) {
        const start = lines.findIndex((line) => line.toLowerCase() === startLabel.toLowerCase());
        if (start === -1) return '';
        const end = lines.findIndex((line, index) => index > start && endLabels.some((label) => line.toLowerCase().startsWith(label.toLowerCase())));
        return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
    }

    function extractCardTables(card) {
        const documentOrder = [...card.querySelectorAll('*')];
        const technicalHeading = findCardSectionHeading(card, CARD_SECTION_LABELS.technical);
        const technicalHeadingPosition = technicalHeading ? documentOrder.indexOf(technicalHeading) : -1;
        return [...card.querySelectorAll(CARD_SELECTORS.tables)]
            .map((table) => ({
                title: findTableTitle(table),
                inDescription: technicalHeadingPosition !== -1 && documentOrder.indexOf(table) < technicalHeadingPosition,
                rows: [...table.querySelectorAll('tr')]
                    .map((row) => [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))
                    .filter((row) => row.length),
            }))
            .filter((table) => table.rows.length);
    }

    function extractCardDescription(card) {
        const technicalHeading = findCardSectionHeading(card, CARD_SECTION_LABELS.technical);
        const contentRoot = technicalHeading?.parentElement;
        if (!technicalHeading || !contentRoot) return '';
        const nodes = [...contentRoot.children];
        const technicalHeadingIndex = nodes.indexOf(technicalHeading);
        if (technicalHeadingIndex === -1) return '';
        const parts = [];
        for (const node of nodes.slice(0, technicalHeadingIndex)) {
            if (node.tagName === 'TABLE') continue;
            const copy = node.cloneNode(true);
            copy.querySelectorAll?.('table').forEach((table) => table.remove());
            const text = (copy.innerText || copy.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) parts.push(text);
        }
        return parts.join('\n\n');
    }

    function findCardSectionHeading(card, labels) {
        const expressions = (Array.isArray(labels) ? labels : [labels])
            .map((label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?$`, 'i'));
        return [...card.querySelectorAll(CARD_SELECTORS.headings)]
            .find((element) => expressions.some((expression) => expression.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())));
    }

    function findTableTitle(table) {
        let previous = table.previousElementSibling;
        for (let index = 0; previous && index < 6; index += 1, previous = previous.previousElementSibling) {
            if (previous.tagName === 'TABLE') break;
            const text = (previous.innerText || previous.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && /:\s*$/.test(text)) return text;
        }
        return '';
    }

    function extractCardLinks(card) {
        const unique = new Set();
        return [...card.querySelectorAll(CARD_SELECTORS.links)]
            .map((link) => ({
                name: link.querySelector('.name')?.getAttribute('title') || link.textContent.replace(/\s+/g, ' ').trim() || link.getAttribute('title') || link.href,
                href: link.href,
                caption: link.dataset.caption || '',
            }))
            .filter((link) => link.href && !/^javascript:/i.test(link.href))
            .filter((link) => {
                const key = `${link.name}|${link.href}`;
                if (unique.has(key)) return false;
                unique.add(key);
                return true;
            });
    }

    function isFileLink(link) {
        return /\.(?:pdf|docx?|xlsx?|xls|pptx?|zip|rar|7z|txt|csv)(?:[?#]|$)/i.test(link.href) || /\.(?:pdf|docx?|xlsx?|xls|pptx?|zip|rar|7z|txt|csv)$/i.test(link.name);
    }

    function isVideoLink(link) {
        return /(?:youtube\.com|youtu\.be|rutube|vkvideo|vimeo|\.mp4(?:[?#]|$)|\.webm(?:[?#]|$)|\.avi(?:[?#]|$)|\.mov(?:[?#]|$))/i.test(link.href);
    }

    function getVideoLabel(link, number) {
        try {
            const url = new URL(link.href);
            const source = getVideoSource(url);
            const identifier = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop();
            return identifier ? `${source}: видео ${number} (${identifier})` : `${source}: видео ${number}`;
        } catch {
            return `Видео ${number}`;
        }
    }

    function getVideoSource(url) {
        return /youtu/i.test(url.hostname) ? 'YouTube' : /rutube/i.test(url.hostname) ? 'Rutube' : /vimeo/i.test(url.hostname) ? 'Vimeo' : /vk/i.test(url.hostname) ? 'VK Видео' : 'Видео';
    }

    function createVideoLinkList(links) {
        const list = createLinkList(links);
        [...list.querySelectorAll('a')].forEach((anchor, index) => {
            const link = links[index];
            loadVideoTitle(link.href).then((title) => {
                if (!title || !anchor.isConnected) return;
                const url = new URL(link.href);
                const identifier = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop();
                anchor.textContent = `${getVideoSource(url)}: ${title}${identifier ? ` (${identifier})` : ''}`;
                anchor.title = title;
            }).catch(() => {});
        });
        return list;
    }

    async function loadVideoTitle(videoUrl) {
        const cache = GM_getValue(VIDEO_TITLE_CACHE_KEY, {}) || {};
        if (cache[videoUrl]) return cache[videoUrl];
        let endpoint = '';
        if (/youtu(?:\.be|be\.com)/i.test(videoUrl)) endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl)}`;
        else if (/rutube\.ru/i.test(videoUrl)) endpoint = `https://rutube.ru/api/oembed/?url=${encodeURIComponent(videoUrl)}`;
        else return '';
        const payload = await requestJson(endpoint);
        const title = String(payload.title || '').trim();
        if (title) {
            cache[videoUrl] = title;
            GM_setValue(VIDEO_TITLE_CACHE_KEY, cache);
        }
        return title;
    }

    function requestJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 12000,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status}`));
                        return;
                    }
                    try { resolve(JSON.parse(response.responseText)); } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }

    function isImageLink(link) {
        return /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i.test(link.href);
    }

    function extractCardImages(card) {
        return [...card.querySelectorAll(CARD_SELECTORS.links)]
            .filter((link) => /изображение продукта/i.test(link.dataset.caption || '') || (isImageLink({ href: link.href }) && link.querySelector('img') && !/file-(?:video|document)\.png/i.test(link.querySelector('img').src || '')))
            .map((link) => ({ src: link.href, alt: link.dataset.caption || link.querySelector('img')?.alt || '' }))
            .filter((image, index, all) => image.src && all.findIndex((candidate) => candidate.src === image.src) === index);
    }

    function isDocumentationLink(link) {
        return /\.(?:pdf|docx?|xlsx?|xls|pptx?|txt|csv)(?:[?#]|$)/i.test(link.href) || /\.(?:pdf|docx?|xlsx?|xls|pptx?|txt|csv)$/i.test(link.name);
    }

    function createCardSection(title, content, expanded = false) {
        const section = document.createElement('section');
        section.style.cssText = 'margin-top:10px;border:1px solid #d7e0e9;border-radius:6px;overflow:hidden';
        const heading = document.createElement('button');
        heading.type = 'button';
        heading.style.cssText = 'display:flex;width:100%;align-items:center;gap:8px;padding:10px 12px;border:0;background:#f3f6f9;color:#17212d;font-weight:700;text-align:left;cursor:pointer';
        const arrow = document.createElement('span');
        arrow.textContent = expanded ? '▾' : '▸';
        const label = document.createElement('span');
        label.textContent = title;
        heading.append(arrow, label);
        const body = document.createElement('div');
        body.style.cssText = `overflow:hidden;max-height:${expanded ? '2400px' : '0'};padding:${expanded ? '12px' : '0 12px'};opacity:${expanded ? '1' : '0'};background:#fff;transition:max-height .28s ease, padding .28s ease, opacity .2s ease`;
        body.appendChild(content);
        if (expanded) requestAnimationFrame(() => { body.style.maxHeight = 'none'; });
        body.addEventListener('transitionend', (event) => {
            if (event.propertyName === 'max-height' && body.style.maxHeight !== '0px' && body.style.maxHeight !== '0') body.style.maxHeight = 'none';
        });
        heading.addEventListener('click', () => {
            const isCollapsed = body.style.maxHeight === '0px' || body.style.maxHeight === '0';
            if (isCollapsed) {
                body.style.maxHeight = `${Math.max(body.scrollHeight + 24, 80)}px`;
                body.style.padding = '12px';
                body.style.opacity = '1';
            } else {
                body.style.maxHeight = `${body.scrollHeight}px`;
                requestAnimationFrame(() => {
                    body.style.maxHeight = '0';
                    body.style.padding = '0 12px';
                    body.style.opacity = '0';
                });
            }
            arrow.textContent = isCollapsed ? '▾' : '▸';
        });
        section.append(heading, body);
        return section;
    }

    function createTextBlock(text) {
        const content = document.createElement('div');
        content.textContent = text;
        content.style.cssText = 'white-space:pre-wrap;line-height:1.55;color:#263444';
        return content;
    }

    function createDescriptionContent(description, tables) {
        const content = document.createElement('div');
        if (description) content.appendChild(createTextBlock(description));
        tables.forEach((table, index) => {
            const heading = document.createElement('h4');
            heading.textContent = table.title || (index === 0 ? 'Сравнительная таблица' : `Таблица ${index + 1}`);
            heading.style.cssText = 'margin:16px 0 8px;color:#334155';
            content.append(heading, createFactsTable(table.rows));
        });
        return content;
    }

    function createTableCollection(tables) {
        const content = document.createElement('div');
        tables.forEach((table, index) => {
            if (index) {
                const divider = document.createElement('div');
                divider.style.cssText = 'height:1px;margin:16px 0;background:#d7e0e9';
                content.appendChild(divider);
            }
            content.appendChild(createFactsTable(table.rows));
        });
        return content;
    }

    function createFactsTable(rows) {
        const columnCount = Math.max(...rows.map((row) => row.length), 1);
        const isWideTable = columnCount >= 3;
        const viewport = document.createElement('div');
        viewport.style.cssText = isWideTable ? 'overflow-x:auto;padding-bottom:2px' : '';
        const table = document.createElement('table');
        table.style.cssText = `width:100%;border-collapse:collapse;line-height:1.4;${isWideTable ? `min-width:${columnCount * 230}px;table-layout:fixed` : ''}`;
        rows.forEach((cells, rowIndex) => {
            const row = document.createElement('tr');
            cells.forEach((value, index) => {
                const cell = document.createElement(isWideTable && rowIndex === 0 ? 'th' : index === 0 ? 'th' : 'td');
                cell.textContent = value;
                const width = isWideTable ? `width:${(100 / columnCount).toFixed(2)}%` : index === 0 ? 'width:35%' : '';
                const header = isWideTable && rowIndex === 0;
                cell.style.cssText = `padding:8px;vertical-align:top;border-bottom:1px solid #e4eaf0;text-align:left;overflow-wrap:break-word;${width};${header || index === 0 ? 'color:#475569;font-weight:600;background:#f8fafc' : 'color:#17212d'}`;
                row.appendChild(cell);
            });
            table.appendChild(row);
        });
        viewport.appendChild(table);
        return viewport;
    }

    function createPhotoGrid(images, productId) {
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px';
        images.forEach((image, index) => {
            const preview = document.createElement('button');
            preview.type = 'button';
            preview.title = image.alt || `Открыть изображение ${index + 1}`;
            preview.style.cssText = 'display:block;padding:5px;border:1px solid #c9d7e5;border-radius:5px;background:#f8fbff;cursor:pointer';
            const picture = document.createElement('img');
            picture.src = image.src;
            picture.alt = image.alt || `Изображение ${index + 1}`;
            picture.loading = 'lazy';
            picture.style.cssText = 'display:block;width:100%;height:112px;object-fit:contain;background:#fff';
            preview.appendChild(picture);
            preview.addEventListener('click', () => openPhotos(productId, image.src));
            grid.appendChild(preview);
        });
        return grid;
    }

    function createLinkList(links, preserveNames = false) {
        const list = document.createElement('div');
        list.style.cssText = 'display:grid;gap:8px';
        links.forEach((link) => {
            const anchor = document.createElement('a');
            anchor.href = link.href;
            anchor.target = '_blank';
            anchor.rel = 'noopener';
            anchor.textContent = link.name;
            anchor.title = link.name;
            anchor.style.cssText = `display:block;padding:8px 10px;border:1px solid #c9d7e5;border-radius:4px;background:#f8fbff;color:#174e8c;text-decoration:none;${preserveNames ? 'white-space:normal;overflow-wrap:anywhere' : ''}`;
            list.appendChild(anchor);
        });
        return list;
    }

    async function openPhotos(productId, initialSource = '') {
        const html = await fetch(`/?q=ajax_get_prod_card&id=${encodeURIComponent(productId)}`).then((response) => response.text());
        const card = new DOMParser().parseFromString(html, 'text/html');
        const images = extractCardImages(card).map((image) => image.src);
        if (!images.length) {
            showToast('В карточке товара нет изображений.');
            return;
        }
        let current = Math.max(0, images.findIndex((source) => source === initialSource));
        let zoom = 1;
        let fitScale = 1;
        let rotation = 0;
        const dialog = overlay('#08111deb');
        const viewport = document.createElement('div');
        Object.assign(viewport.style, { width: '88vw', height: '70vh', maxWidth: '88vw', overflow: 'auto', background: '#111827', cursor: 'grab', touchAction: 'none' });
        const canvas = document.createElement('div');
        Object.assign(canvas.style, { position: 'relative', margin: 'auto' });
        const image = document.createElement('img');
        Object.assign(image.style, { position: 'absolute', left: '50%', top: '50%', display: 'block', maxWidth: 'none', maxHeight: 'none', objectFit: 'contain', userSelect: 'none', transformOrigin: 'center' });
        image.draggable = false;
        image.addEventListener('dragstart', (event) => event.preventDefault());
        canvas.appendChild(image);
        viewport.appendChild(canvas);
        const counter = document.createElement('div');
        counter.style.cssText = 'color:#fff;text-align:center;margin-top:8px';
        const updateFitScale = () => {
            const rotated = rotation % 180 !== 0;
            const sourceWidth = rotated ? image.naturalHeight : image.naturalWidth;
            const sourceHeight = rotated ? image.naturalWidth : image.naturalHeight;
            fitScale = Math.min(viewport.clientWidth / sourceWidth, viewport.clientHeight / sourceHeight, 1);
        };
        const applyZoom = () => {
            if (!image.naturalWidth || !image.naturalHeight) return;
            const imageWidth = Math.round(image.naturalWidth * fitScale * zoom);
            const imageHeight = Math.round(image.naturalHeight * fitScale * zoom);
            const rotated = rotation % 180 !== 0;
            canvas.style.width = `${rotated ? imageHeight : imageWidth}px`;
            canvas.style.height = `${rotated ? imageWidth : imageHeight}px`;
            image.style.width = `${imageWidth}px`;
            image.style.height = `${imageHeight}px`;
            image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
        };
        image.onload = () => {
            updateFitScale();
            applyZoom();
        };
        const resetViewport = () => viewport.scrollTo({ left: 0, top: 0 });
        const update = () => { zoom = 1; rotation = 0; resetViewport(); image.src = images[current]; counter.textContent = `${current + 1} / ${images.length}`; };
        const close = () => { dialog.remove(); window.removeEventListener('keydown', onKeyDown); };
        const showPrevious = () => { current = (current - 1 + images.length) % images.length; update(); };
        const showNext = () => { current = (current + 1) % images.length; update(); };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') close();
            if (event.key === 'ArrowLeft') { event.preventDefault(); showPrevious(); }
            if (event.key === 'ArrowRight') { event.preventDefault(); showNext(); }
        };
        window.addEventListener('keydown', onKeyDown);
        dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
        let dragStart = null;
        viewport.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStart = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
            viewport.setPointerCapture(event.pointerId);
            viewport.style.cursor = 'grabbing';
        });
        viewport.addEventListener('pointermove', (event) => {
            if (!dragStart) return;
            event.preventDefault();
            viewport.scrollLeft = dragStart.left - (event.clientX - dragStart.x);
            viewport.scrollTop = dragStart.top - (event.clientY - dragStart.y);
        });
        const stopDragging = () => { dragStart = null; viewport.style.cursor = 'grab'; };
        viewport.addEventListener('pointerup', stopDragging);
        viewport.addEventListener('pointercancel', stopDragging);
        viewport.addEventListener('wheel', (event) => {
            event.preventDefault();
            const nextZoom = Math.min(5, Math.max(.5, zoom + (event.deltaY < 0 ? .15 : -.15)));
            if (nextZoom === zoom) return;
            zoom = nextZoom;
            applyZoom();
        }, { passive: false });
        const controls = document.createElement('div');
        controls.style.cssText = 'display:grid;justify-content:center;gap:8px;margin-top:10px';
        const navigationControls = document.createElement('div');
        navigationControls.style.cssText = 'display:flex;justify-content:center;gap:8px;flex-wrap:wrap';
        navigationControls.append(
            button('←', showPrevious, 'primary', 'Предыдущее фото (стрелка влево)'),
            button('→', showNext, 'primary', 'Следующее фото (стрелка вправо)'),
            button('Сбросить', () => { zoom = 1; rotation = 0; updateFitScale(); applyZoom(); resetViewport(); }, 'neutral', 'Вернуть исходный масштаб и поворот'),
            button('Закрыть', close, 'neutral', 'Закрыть (Esc)'),
        );
        const transformControls = document.createElement('div');
        transformControls.style.cssText = 'display:flex;justify-content:center;gap:8px;flex-wrap:wrap';
        transformControls.append(
            button('−', () => { zoom = Math.max(.5, zoom - .25); applyZoom(); }, 'neutral', 'Уменьшить'),
            button('+', () => { zoom = Math.min(5, zoom + .25); applyZoom(); }, 'neutral', 'Увеличить'),
            button('↶', () => { rotation = (rotation + 270) % 360; updateFitScale(); applyZoom(); resetViewport(); }, 'neutral', 'Повернуть на 90° влево'),
            button('↷', () => { rotation = (rotation + 90) % 360; updateFitScale(); applyZoom(); resetViewport(); }, 'neutral', 'Повернуть на 90° вправо'),
        );
        controls.append(navigationControls, transformControls);
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { textAlign: 'center', maxWidth: '95vw' });
        wrap.append(viewport, counter, controls);
        dialog.appendChild(wrap);
        update();
    }

    function openItemEditor(source, afterSave) {
        const item = source && source.custom ? source : { code: source?.code || '', title: source?.title || '', category: source?.category || '', equipment: source?.equipment || '', note: source?.note || '', url: source?.url || '', productId: source?.productId || '' };
        const dialog = overlay();
        const box = modalBox(source?.custom ? 'Изменить локальную позицию' : 'Добавить локальную позицию / заметку');
        const equipmentListId = `opc-equipment-list-${crypto.randomUUID()}`;
        box.innerHTML += `
            <label>Код 1С / артикул<br><input data-field="code"></label>
            <label>Название<br><input data-field="title"></label>
            <label>Категория<br><select data-field="category"><option value="">Выберите категорию</option><option value="ЗИП">ЗИП</option><option value="Оборудование">Оборудование</option></select></label>
            <label>Связь с оборудованием<br><input data-field="equipment" list="${equipmentListId}" placeholder="Введите модель или выберите из списка"></label>
            <datalist id="${equipmentListId}"></datalist>
            <label>Комментарий<br><textarea data-field="note" rows="4"></textarea></label>
            <label>Ссылка на товар или карточку<br><input data-field="url"></label>
            <div data-actions></div>`;
        const equipmentList = box.querySelector(`#${equipmentListId}`);
        getEquipmentOptions().forEach((equipment) => equipmentList.appendChild(new Option(equipment)));
        ['code', 'title', 'category', 'equipment', 'note', 'url'].forEach((field) => { box.querySelector(`[data-field="${field}"]`).value = item[field] || ''; });
        addAction(box, 'Сохранить', () => {
            const saved = Object.fromEntries(['code', 'title', 'category', 'equipment', 'note', 'url'].map((field) => [field, box.querySelector(`[data-field="${field}"]`).value.trim()]));
            if (!saved.title) { alert('Укажите название позиции.'); return; }
            if (!saved.category) { alert('Выберите категорию: ЗИП или Оборудование.'); return; }
            const custom = getCustomItems();
            if (source?.custom) Object.assign(source, makeSearchableItem(saved));
            else custom.push(makeSearchableItem({ ...saved, custom: true, id: crypto.randomUUID() }));
            GM_setValue(CUSTOM_ITEMS_KEY, custom);
            dialog.remove();
            showIndexStatus();
            afterSave?.();
        }, true);
        if (source?.custom) {
            const remove = button('Удалить', () => {
                if (!confirm(`Удалить локальную позицию «${source.title}»?`)) return;
                GM_setValue(CUSTOM_ITEMS_KEY, getCustomItems().filter((custom) => custom.id !== source.id));
                dialog.remove();
                showIndexStatus();
                afterSave?.();
                showToast('Локальная позиция удалена.', 'success');
            }, 'danger', 'Удалить локальную позицию');
            remove.style.margin = '16px 8px 0 0';
            box.querySelector('[data-actions]').appendChild(remove);
        }
        addAction(box, 'Закрыть', () => dialog.remove());
        dialog.appendChild(box);
    }

    function overlay(background = 'rgba(0,0,0,.62)') {
        const element = document.createElement('div');
        Object.assign(element.style, { position: 'fixed', inset: '0', zIndex: '2147483647', display: 'grid', placeItems: 'center', background });
        element.addEventListener('click', (event) => { if (event.target === element) element.remove(); });
        document.body.appendChild(element);
        return element;
    }

    function showToast(message, tone = 'danger') {
        document.getElementById('opc-toast')?.remove();
        const toast = document.createElement('div');
        const toolbar = document.getElementById('opc-toolbar');
        const colors = {
            danger: { background: '#f9dede', border: '#d49a9a', color: '#7d2424' },
            success: { background: '#dff3e5', border: '#8fc6a0', color: '#1d5a34' },
            warning: { background: '#fff4cc', border: '#ddbd67', color: '#6d4a00' },
        };
        const color = colors[tone] || colors.danger;
        toast.id = 'opc-toast';
        toast.textContent = message;
        Object.assign(toast.style, {
            position: toolbar ? 'absolute' : 'fixed', left: toolbar ? '50%' : 'auto', right: toolbar ? 'auto' : '20px', top: toolbar ? '10px' : 'auto', bottom: toolbar ? 'auto' : '20px', zIndex: '2147483647',
            maxWidth: '360px', padding: '11px 14px', border: `1px solid ${color.border}`, borderRadius: '5px',
            background: color.background, color: color.color, boxShadow: '0 5px 18px rgba(0,0,0,.18)',
            font: '14px Arial,sans-serif', opacity: '0', transform: toolbar ? 'translate(-50%, -8px)' : 'translateY(8px)', transition: 'opacity .2s ease, transform .2s ease',
        });
        (toolbar || document.body).appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = toolbar ? 'translate(-50%, 0)' : 'translateY(0)'; });
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = toolbar ? 'translate(-50%, -8px)' : 'translateY(8px)'; }, 2600);
        setTimeout(() => toast.remove(), 2900);
    }

    function modalBox(title) {
        const box = document.createElement('div');
        Object.assign(box.style, { width: '620px', maxWidth: 'calc(100% - 32px)', maxHeight: 'calc(100% - 48px)', overflowY: 'auto', padding: '18px', borderRadius: '8px', background: '#fff', color: '#17212d', font: '14px Arial,sans-serif' });
        box.innerHTML = `<h3 style="margin-top:0">${escapeHtml(title)}</h3>`;
        return box;
    }

    function addAction(box, text, handler, primary = false) {
        const host = box.querySelector('[data-actions]');
        const element = button(text, handler, primary ? 'success' : 'neutral');
        element.style.margin = '16px 8px 0 0';
        host.appendChild(element);
    }

    function button(text, handler, tone = 'neutral', title = '') {
        const element = document.createElement('button');
        element.textContent = text;
        element.title = title;
        styleButton(element, tone);
        element.onclick = handler;
        return element;
    }

    function styleButton(element, tone = 'neutral') {
        const colors = {
            primary: { background: '#dce9ff', border: '#8dadde', color: '#183a70' },
            success: { background: '#dff3e5', border: '#8fc6a0', color: '#1d5a34' },
            info: { background: '#d9f0ee', border: '#85c3be', color: '#155853' },
            warning: { background: '#fbe8d4', border: '#ddb07d', color: '#7a3f10' },
            danger: { background: '#f9dede', border: '#db9999', color: '#7d2424' },
            neutral: { background: '#f7f9fc', border: '#b7c2d0', color: '#26384c' },
        };
        const color = colors[tone] || colors.neutral;
        Object.assign(element.style, { padding: '7px 10px', border: `1px solid ${color.border}`, borderRadius: '4px', background: color.background, color: color.color, cursor: 'pointer', fontWeight: '600' });
        element.onmouseenter = () => { element.style.filter = 'brightness(.92)'; };
        element.onmouseleave = () => { element.style.filter = ''; };
    }

    function uniqueBy(items, key) {
        const map = new Map();
        items.forEach((item) => map.set(key(item), item));
        return [...map.values()];
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value || '');
        return element.innerHTML;
    }
})();
