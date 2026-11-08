import {
  getSettings,
  updateSettings,
  getDownloadHistory,
  removeFromDownloadHistory,
  clearDownloadHistory,
  clearProcessedPostsMemory,
  getProcessedPostsSummary,
  clearProcessedPostsBySubreddit,
  clearProcessedPostsByUser,
  getSubscriptions,
  addSubscription,
  removeSubscription,
  updateSubscription,
  reorderSubscriptions,
  getFailedDownloads,
  removeFailedDownload,
  clearFailedDownloads,
  exportBackup,
  importBackup,
  exportFollowList,
  importFollowList,
  setSubscriptionFavorite,
  MAX_FAVORITES,
  parseFollowEntry,
} from "./src/storage.js";
import { createLogger } from "./src/log.js";

const log = createLogger("panel");
import { LOCALES, LANGUAGE_NAMES, SUPPORTED_LANGUAGES, detectDefaultLanguage, t, tf } from "./locales.js";

    // --- Dil sistemi ---
    let currentLang = detectDefaultLanguage();
    const langSelectEl = document.getElementById("langSelect");

    SUPPORTED_LANGUAGES.forEach((code) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = LANGUAGE_NAMES[code];
      langSelectEl.appendChild(opt);
    });

    function applyTranslations() {
      document.documentElement.lang = currentLang;
      document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(currentLang, el.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        el.placeholder = t(currentLang, el.dataset.i18nPlaceholder);
      });
      // ÖNEMLİ YENİ ÖZELLİK: Daha kompakt bir görünüm için, bazı uzun
      // açıklamaları görünür etiketten çıkarıp fare üzerine gelince/dokununca
      // çıkan bir ipucuna (native tooltip) taşıyoruz — bilgi kaybolmuyor,
      // sadece varsayılan olarak gizli.
      document.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.title = t(currentLang, el.dataset.i18nTitle);
      });
      langSelectEl.value = currentLang;
    }

    langSelectEl.addEventListener("change", async () => {
      currentLang = langSelectEl.value;
      applyTranslations();
      await updateSettings({ language: currentLang });
      renderHistory(); // geçmişteki "boş" metni ve göreceli zamanları da güncelle
      renderFailed();
      // ÖNEMLİ DÜZELTME: Takip sekmesindeki dinamik olarak JS ile üretilen
      // metinler (grup başlıkları, kaydırma çubuğu değeri, geri sayım,
      // "son kontrol" zamanları) data-i18n KULLANMIYOR — bu yüzden dil
      // değişince bunları da elle yeniden çizmemiz gerekiyor.
      renderSubscriptions();
      loadIntervalSlider();
      updateNextCheckText();
      // ÖNEMLİ DÜZELTME: Arşiv Yönetimi paneli de aynı sebepten (JS ile
      // üretilen metin, data-i18n kullanmıyor) dil değişince güncellenmiyordu
      // — panel açıkken dil değiştirilirse eski dilde donup kalıyordu.
      // Sadece panel gerçekten açıksa yeniden çiziyoruz (gereksiz iş olmasın).
      if (archiveManagerWrapEl.style.display === "block") {
        renderArchiveManager();
      }
    });

    // v1.50.3: Yüzde işareti dile göre ("%50" sadece Türkçede doğru; İngilizcede "50%").
    function formatPercent(value) {
      const tag = String(currentLang || "en").replace("_", "-").replace(/-(br|cn)$/i, (m) => m.toUpperCase());
      try {
        return new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
      } catch {
        return `${value}%`;
      }
    }

    // --- Açık/Koyu tema manuel geçişi ---
    const themeToggleBtnEl = document.getElementById("themeToggleBtn");

    function applyTheme(theme) {
      document.documentElement.classList.remove("theme-light", "theme-dark");
      if (theme === "light") {
        document.documentElement.classList.add("theme-light");
        themeToggleBtnEl.textContent = "☀️";
      } else if (theme === "dark") {
        document.documentElement.classList.add("theme-dark");
        themeToggleBtnEl.textContent = "🌙";
      } else {
        // Sistem temasını takip et — ikon, sistemin şu anki tercihini yansıtsın.
        const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        themeToggleBtnEl.textContent = systemPrefersDark ? "🌙" : "☀️";
      }
    }

    themeToggleBtnEl.addEventListener("click", async () => {
      const settings = await getSettings();
      const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const current = settings.theme || (systemPrefersDark ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      await updateSettings({ theme: next });
    });

    // --- Alt bilgi: versiyon numarası ---
    document.getElementById("versionText").textContent = `v${chrome.runtime.getManifest().version}`;

    // Kaynak kod / Değerlendir linkleri: mağazada henüz yayınlanmadığımız
    // için gerçek adresler yok — tıklanınca bilgilendirme veriyoruz.
    document.getElementById("sourceCodeLink").addEventListener("click", (e) => {
      e.preventDefault();
      alert("Bu eklenti henüz bir genel kod deposunda yayınlanmadı.");
    });
    document.getElementById("rateExtensionLink").addEventListener("click", (e) => {
      e.preventDefault();
      alert("Bu eklenti henüz Chrome Web Store'da yayınlanmadı, yayınlandığında buradan değerlendirebileceksiniz.");
    });

    // --- Reddit gerektiren tek bölge: "Bu Sayfadaki Tüm Medyaları İndir".
    // ÖNEMLİ: Önceden bu kontrol TÜM PANELİ (Ayarlar/Geçmiş/Takip dahil)
    // gizliyordu — ama o sekmeler Reddit'in açık olmasına hiç ihtiyaç
    // duymuyor (arka planda çalışıyorlar). Artık sadece bu tek bölgeyi
    // etkiliyor, geri kalan her şey her zaman kullanılabilir.
    const bulkBtnEl_forToggle = document.getElementById("bulkBtn");
    const stopBtnEl_forToggle = document.getElementById("stopBtn");
    const notRedditNoticeEl = document.getElementById("notRedditNotice");
    const gotoRedditBtnInlineEl = document.getElementById("gotoRedditBtnInline");
    const redditTabPickerWrapEl = document.getElementById("redditTabPickerWrap");
    const redditTabPickerEl = document.getElementById("redditTabPicker");

    // ÖNEMLİ YENİ ÖZELLİK: Birden fazla Reddit sekmesi açıkken, panel artık
    // "şu an aktif olan sekme" ile sınırlı kalmıyor. Kullanıcı açılır
    // menüden hangi Reddit sekmesinden indirmek istediğini seçebiliyor —
    // bu, "indirmek için o sekmeye geçmiş olmanız gerekir" kısıtını kaldırıyor.
    let selectedTabId = null;
    // ÖNEMLİ DÜZELTME: Kullanıcı elle bir seçim yapmadığı sürece, seçili
    // sekmenin tarayıcıda gerçekten aktif olan sekmeyi OTOMATİK takip
    // etmesi gerekiyordu — önceden hep "yapışkan" kalıyordu, sekme
    // değiştirince panel güncellenmiyordu. Artık sadece kullanıcı açılır
    // menüden ELLE bir seçim yaptıktan SONRA o seçimde kilitleniyoruz.
    let userExplicitlySelectedTab = false;

    /** Açık tüm Reddit sekmelerini bulup açılır menüyü günceller. */
    async function refreshRedditTabsDropdown() {
      const redditTabs = await chrome.tabs.query({ url: ["*://*.reddit.com/*"] });
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (redditTabs.length === 0) {
        redditTabPickerWrapEl.style.display = "none";
        selectedTabId = null;
        userExplicitlySelectedTab = false;
        return;
      }

      // Tek bir Reddit sekmesi varsa seçecek bir şey yok, menüyü gizle.
      redditTabPickerWrapEl.style.display = redditTabs.length > 1 ? "block" : "none";

      const stillValid = selectedTabId && redditTabs.some((t) => t.id === selectedTabId);
      if (!stillValid) {
        userExplicitlySelectedTab = false; // seçili sekme kapanmış, otomatik takibe dön
      }

      if (!userExplicitlySelectedTab) {
        // Kullanıcı elle bir şey seçmediyse, o an tarayıcıda GERÇEKTEN
        // aktif olan Reddit sekmesini otomatik takip et.
        const activeIsReddit = redditTabs.find((t) => t.id === activeTab?.id);
        selectedTabId = (activeIsReddit || redditTabs[0]).id;
      }

      redditTabPickerEl.innerHTML = "";
      redditTabs.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = String(t.id);
        const label = (t.title || t.url || "").slice(0, 60);
        // Tarayıcıda o an gerçekten görüntülenen sekmeyi bir nokta ile işaretle.
        opt.textContent = t.id === activeTab?.id ? `● ${label}` : label;
        opt.selected = t.id === selectedTabId;
        redditTabPickerEl.appendChild(opt);
      });
    }

    redditTabPickerEl.addEventListener("change", () => {
      selectedTabId = Number(redditTabPickerEl.value);
      userExplicitlySelectedTab = true; // artık otomatik takibi durdur, bu seçimde kal
      checkActiveTabForPageDownload();
    });

    /** Toplu indirme/durdur gibi tüm işlemler için kullanılacak hedef sekmeyi döner. */
    async function getTargetTab() {
      if (selectedTabId) {
        try {
          const tab = await chrome.tabs.get(selectedTabId);
          if (tab) return tab;
        } catch {
          selectedTabId = null; // sekme kapanmış olmalı, temizle
        }
      }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return activeTab;
    }

    async function checkActiveTabForPageDownload() {
      await refreshRedditTabsDropdown();
      const tab = await getTargetTab();
      const isReddit = !!tab?.url && /^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i.test(tab.url);
      notRedditNoticeEl.style.display = isReddit ? "none" : "block";
      // Toplu indirme aktif çalışırken (durdur butonu görünürken) bu
      // görünürlüğü ezmeyelim.
      if (stopBtnEl_forToggle.style.display !== "block") {
        bulkBtnEl_forToggle.style.display = isReddit ? "block" : "none";
      }
    }

    gotoRedditBtnInlineEl.addEventListener("click", async () => {
      const tab = await getTargetTab();
      if (tab?.id) chrome.tabs.update(tab.id, { url: "https://www.reddit.com" });
    });

    checkActiveTabForPageDownload();
    // Panel açıkken kullanıcı başka bir sekmeye/sayfaya geçerse tekrar kontrol et.
    chrome.tabs.onActivated.addListener(checkActiveTabForPageDownload);
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.status === "complete") checkActiveTabForPageDownload();
    });
    // Reddit sekmelerinden biri kapanırsa açılır menüyü tazele.
    chrome.tabs.onRemoved.addListener(() => refreshRedditTabsDropdown());

    // --- Sekme geçişleri ---
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
        // ÖNEMLİ YENİ İYİLEŞTİRME: Kullanıcı, kopyaladığı bir kullanıcı/
        // subreddit adını "Yeni Takip Ekle" alanına yapıştırmaya
        // çalıştığında bazen odağın (focus) tam olarak o alana
        // geçmediğini ve yapıştırmanın adres çubuğuna gittiğini fark
        // etti. Kesin sebebi ne olursa olsun, en güvenilir çözüm: Takip
        // sekmesine geçildiğinde giriş alanına HEMEN otomatik
        // odaklanmak — kullanıcı tıklamaya bile gerek kalmadan
        // yapıştırabilsin diye.
        // v1.47.4: Sadece panel GERÇEKTEN klavye odağına sahipse odakla.
        // Panel odakta değilken yapılan programatik odaklama, alanda yanıp
        // sönen bir imleç gösterip klavyenin hâlâ adres çubuğunda olduğu
        // yanıltıcı bir durum yaratıyordu (Ctrl+V adres çubuğuna gidiyordu).
        if (btn.dataset.tab === "subs" && document.hasFocus()) {
          setTimeout(() => document.getElementById("subNameInput")?.focus(), 50);
        }
      });
    });

    /** v1.47.0: Boş durum mesajı, innerHTML kullanmadan (Firefox eklenti incelemesi innerHTML'i işaretliyor). */
    function setEmptyMessage(container, className, text) {
      container.replaceChildren();
      const div = document.createElement("div");
      div.className = className;
      div.textContent = text;
      container.appendChild(div);
    }

    // --- Geçmiş sekmesi ---
    const historyContentEl = document.getElementById("historyContent");
    const countBadgeEl = document.getElementById("countBadge");
    const clearBtnEl = document.getElementById("clearBtn");

    // v1.45.0: Göreli zaman artık tarayıcının yerleşik çevirisiyle
    // (Intl.RelativeTimeFormat) 15 dilin hepsinde doğru; önceden sadece
    // İngilizce ve Türkçe vardı, diğer diller İngilizce görüyordu.
    function formatRelativeTime(timestamp) {
      const locale = currentLang.replace("_", "-");
      let rtf;
      try {
        rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
      } catch {
        rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
      }
      const diffMin = Math.floor((Date.now() - timestamp) / 60000);
      if (diffMin < 1) return rtf.format(0, "minute");
      if (diffMin < 60) return rtf.format(-diffMin, "minute");
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return rtf.format(-diffHour, "hour");
      return rtf.format(-Math.floor(diffHour / 24), "day");
    }

    const historySearchEl = document.getElementById("historySearch");
    const failedContentEl = document.getElementById("failedContent");
    historySearchEl.addEventListener("input", () => renderHistory());

    function makeIconButton(label, title, onClick) {
      const btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", onClick);
      return btn;
    }

    /** v1.45.2: Dosya hâlâ diskte duruyorsa klasörde gösterir; silinmişse kullanıcıya söyler. */
    async function showDownloadedFile(downloadIds) {
      for (const id of downloadIds || []) {
        const [item] = await chrome.downloads.search({ id });
        if (item?.exists && item.state === "complete") {
          chrome.downloads.show(id);
          return;
        }
      }
      alert(t(currentLang, "historyFileMissing"));
    }

    async function renderFailed() {
      const failed = await getFailedDownloads();
      failedContentEl.innerHTML = "";
      if (failed.length === 0) return;
      const box = document.createElement("div");
      box.className = "failed-box";
      const head = document.createElement("div");
      head.className = "failed-head";
      const title = document.createElement("span");
      title.textContent = `⚠ ${t(currentLang, "failedTitle")} (${failed.length})`;
      const actions = document.createElement("div");
      actions.className = "head-actions";
      const retryAll = document.createElement("button");
      retryAll.textContent = t(currentLang, "failedRetryAll");
      retryAll.addEventListener("click", async () => {
        retryAll.disabled = true;
        await chrome.runtime.sendMessage({ type: "RETRY_FAILED" });
        renderFailed();
      });
      const clearAll = document.createElement("button");
      clearAll.textContent = t(currentLang, "failedClear");
      clearAll.addEventListener("click", async () => {
        await clearFailedDownloads();
        renderFailed();
      });
      actions.append(retryAll, clearAll);
      head.append(title, actions);
      box.appendChild(head);

      const list = document.createElement("ul");
      list.className = "failed-list";
      for (const rec of failed) {
        const li = document.createElement("li");
        const info = document.createElement("div");
        info.style.minWidth = "0";
        const name = document.createElement("div");
        name.className = "item-title";
        name.textContent = rec.meta?.title || rec.media?.urls?.[0] || "—";
        name.title = name.textContent;
        const err = document.createElement("div");
        err.className = "err";
        err.textContent = `r/${rec.meta?.subreddit || "?"} · ${formatRelativeTime(rec.timestamp)} · ${rec.error || ""}`;
        info.append(name, err);
        const acts = document.createElement("div");
        acts.className = "item-actions";
        acts.append(
          makeIconButton("↻", t(currentLang, "failedRetry"), async (e) => {
            e.currentTarget.disabled = true;
            await chrome.runtime.sendMessage({ type: "RETRY_FAILED", ids: [rec.id] });
            renderFailed();
          }),
          makeIconButton("✕", t(currentLang, "failedRemove"), async () => {
            await removeFailedDownload(rec.id);
            renderFailed();
          }),
        );
        li.append(info, acts);
        list.appendChild(li);
      }
      box.appendChild(list);
      failedContentEl.appendChild(box);
    }

    async function renderHistory() {
      const history = await getDownloadHistory();
      countBadgeEl.textContent = history.length > 0 ? `${history.length}` : "";
      clearBtnEl.style.display = history.length > 0 ? "inline-block" : "none";
      historySearchEl.style.display = history.length > 0 ? "block" : "none";

      if (history.length === 0) {
        setEmptyMessage(historyContentEl, "empty-state", t(currentLang, "historyEmpty"));
        return;
      }

      // v1.45.2: arama (başlık, subreddit, kullanıcı; büyük/küçük harf duyarsız)
      const q = historySearchEl.value.trim().toLocaleLowerCase();
      const matches = (entry) =>
        !q || [entry.title, entry.subreddit, entry.author].some((v) => String(v || "").toLocaleLowerCase().includes(q));

      const list = document.createElement("ul");
      list.className = "history-list";
      history.forEach((entry, index) => {
        if (!matches(entry)) return;
        const li = document.createElement("li");
        li.className = "history-item";

        const info = document.createElement("div");
        info.className = "item-info";
        const titleEl = document.createElement("div");
        titleEl.className = "item-title";
        titleEl.textContent = entry.title || "—";
        titleEl.title = entry.title || "";
        // v1.45.2: başlığa tıklayınca gönderi yeni sekmede açılır
        const permalink = entry.permalink || (String(entry.key || "").includes("/comments/") ? entry.key : null);
        if (permalink) {
          titleEl.classList.add("link");
          titleEl.title = `${entry.title || ""}\n${t(currentLang, "historyOpenPost")}`;
          titleEl.addEventListener("click", () => chrome.tabs.create({ url: `https://www.reddit.com${permalink}` }));
        }
        const metaEl = document.createElement("div");
        metaEl.className = "item-meta";
        const countLabel = entry.count > 1 ? `${entry.count} · ` : "";
        const authorLabel = entry.author && entry.author !== "unknown" ? `u/${entry.author} · ` : "";
        metaEl.textContent = `r/${entry.subreddit} · ${authorLabel}${countLabel}${formatRelativeTime(entry.timestamp)}`;
        info.appendChild(titleEl);
        info.appendChild(metaEl);

        const actions = document.createElement("div");
        actions.className = "item-actions";
        if (entry.downloadIds?.length) {
          actions.appendChild(makeIconButton("📁", t(currentLang, "historyShowFile"), () => showDownloadedFile(entry.downloadIds)));
        }
        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-btn";
        removeBtn.textContent = "✕";
        removeBtn.addEventListener("click", async () => {
          await removeFromDownloadHistory(index);
          renderHistory();
        });
        actions.appendChild(removeBtn);

        li.appendChild(info);
        li.appendChild(actions);
        list.appendChild(li);
      });

      historyContentEl.innerHTML = "";
      if (!list.children.length) {
        setEmptyMessage(historyContentEl, "empty-state", t(currentLang, "historyNoMatch"));
        return;
      }
      historyContentEl.appendChild(list);
    }

    clearBtnEl.addEventListener("click", async () => {
      if (!confirm(t(currentLang, "confirmClearHistory"))) return;
      await clearDownloadHistory();
      renderHistory();
    });

    renderHistory();
    renderFailed();

    // v1.48.3: yeni kurulum karşılama kutusu: hesaptan/indirme geçmişinden ne geri geldiğini gösterir
    const freshInstallBoxEl = document.getElementById("freshInstallBox");
    const freshMsgEl = document.getElementById("freshMsg");
    function showFreshMsg(text, isError) {
      freshMsgEl.textContent = text;
      freshMsgEl.style.color = isError ? "var(--danger)" : "var(--text)";
      freshMsgEl.style.display = "block";
    }
    async function renderFreshInstall() {
      const { freshInstall } = await chrome.storage.local.get("freshInstall");
      freshInstallBoxEl.style.display = freshInstall ? "block" : "none";
      if (!freshInstall) return;
      const subs = await getSubscriptions();
      const lines = [];
      if (freshInstall.restoredSettings || subs.length) lines.push(`✓ ${tf(currentLang, "freshFromAccount", { n: subs.length })}`);
      const r = freshInstall.recovered;
      if (r?.downloadedAdded || r?.historyAdded) lines.push(`✓ ${tf(currentLang, "recoverDownloadsDone", { posts: r.downloadedAdded, history: r.historyAdded, legacy: r.legacy })}`);
      if (!lines.length) lines.push(t(currentLang, "freshNothingYet"));
      document.getElementById("freshInstallLines").textContent = lines.join("\n");
    }
    async function finishFreshInstall() {
      await chrome.storage.local.remove("freshInstall");
    }
    document.getElementById("freshInstallClose").addEventListener("click", async () => {
      await finishFreshInstall();
      renderFreshInstall();
    });
    document.getElementById("freshRecoverBtn").addEventListener("click", () => runRecoverFromDownloads(showFreshMsg));
    document.getElementById("freshImportBtn").addEventListener("click", () => document.getElementById("freshImportFile").click());
    document.getElementById("freshImportFile").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const r = await importBackup(JSON.parse(await file.text()));
        showFreshMsg(`✓ ${tf(currentLang, "backupImported", { subs: r.subscriptionsAdded, posts: r.downloadedAdded, history: r.historyAdded })}`);
        await finishFreshInstall(); // artık otomatik yedekler ana dosyaya yazabilir
        await loadSettingsIntoForm();
        renderHistory();
        renderSubscriptions();
        setTimeout(renderFreshInstall, 6000);
      } catch (error) {
        log.warn("Yedek içe aktarılamadı:", error);
        showFreshMsg(`⚠ ${t(currentLang, "backupInvalid")}`, true);
      }
    });
    renderFreshInstall();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.freshInstall) renderFreshInstall();
    });

    // v1.47.5: başka bir eklenti (IDM vb.) dosya adlarını devralıyorsa uyarı
    const namingConflictBoxEl = document.getElementById("namingConflictBox");
    async function renderNamingConflict() {
      const { namingConflict, namingConflictDismissedAt = 0 } = await chrome.storage.local.get(["namingConflict", "namingConflictDismissedAt"]);
      const show = namingConflict && namingConflict.at > namingConflictDismissedAt;
      namingConflictBoxEl.style.display = show ? "block" : "none";
      if (show) {
        document.getElementById("namingConflictExample").textContent = `${t(currentLang, "namingConflictWanted")}: ${namingConflict.expected}\n→ ${namingConflict.actual}`;
      }
    }
    document.getElementById("namingConflictClose").addEventListener("click", async () => {
      await chrome.storage.local.set({ namingConflictDismissedAt: Date.now() });
      renderNamingConflict();
    });
    renderNamingConflict();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.namingConflict || changes.namingConflictDismissedAt)) renderNamingConflict();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      // ÖNEMLİ DÜZELTME: Takip listesi artık İKİ AYRI depoda tutuluyor —
      // "kimlik" (subscriptionsIdentity) SENKRONİZE depoda, "durum"
      // (subscriptionsState — lastCheckedAt, lastSeenId, pendingPosts)
      // YEREL depoda. Önceden burada "area !== 'local' ise hiç bakma"
      // diye baştan çıkıyorduk ve sadece eski (artık kullanılmayan)
      // "subscriptions" anahtarını dinliyorduk — bu yüzden "Şimdi
      // Kontrol Et" sırasında her abonelik tek tek kontrol edilirken
      // panel hiç güncellenmiyor, sadece EN SONUNDA (başka bir
      // tetikleyiciyle) yenileniyordu. Artık her iki depoyu da,
      // ilgili alanlarına göre doğru şekilde dinliyoruz.
      if (area === "local") {
        if (changes.downloadHistory) renderHistory();
        if (changes.failedDownloads) renderFailed();
        if (changes.subscriptionsState) renderSubscriptions();
      }
      // v1.45.5: takip listesi artık parçalı (subsChunk_N) ve yerel kopyası da var
      if (area === "sync" && Object.keys(changes).some((k) => k === "subscriptionsIdentity" || k === "subsChunkCount" || k.startsWith("subsChunk_"))) renderSubscriptions();
      if (area === "local" && changes.subscriptionsIdentityFallback) renderSubscriptions();
    });

    // --- Ayarlar sekmesi ---
    const folderInput = document.getElementById("folderDestination");
    const filenameInput = document.getElementById("filenamePattern");
    const galleryFoldersInput = document.getElementById("useGalleryFolders");
    const markDownloadedInput = document.getElementById("markDownloaded");
    const showDownloadedMarkersInput = document.getElementById("showDownloadedMarkers");
    const markAsVisitedInput = document.getElementById("markAsVisited");
    const embedTitleOnImagesInput = document.getElementById("embedTitleOnImages");
    const embedTitleOnVideosInput = document.getElementById("embedTitleOnVideos");
    const skipDuplicateMediaInput = document.getElementById("skipDuplicateMedia");
    const debugLogsInput = document.getElementById("debugLogs");
    const downloadThroughExtensionInput = document.getElementById("downloadThroughExtension");
    const enableDateFilterInput = document.getElementById("enableDateFilter");
    const dateRangeFieldsEl = document.getElementById("dateRangeFields");
    const dateFromInput = document.getElementById("dateFrom");
    const dateToInput = document.getElementById("dateTo");
    const saveBtnEl = document.getElementById("saveBtn");
    const savedMsgEl = document.getElementById("savedMsg");

    // Ayarlar sekmesinde, Kaydet butonunun ALTINDA duran hızlı seçenekler —
    // orijinal eklentideki gibi, değiştirildiği an kaydediliyor (ayrı bir
    // "Kaydet"e basmaya gerek yok, çünkü bunlar toplu indirme anlık ayarları).
    const mediaTypeFilterInput = document.getElementById("mediaTypeFilter");
    const scrollUpCheckboxEl = document.getElementById("scrollUpCheckbox");
    const clearProcessedBtnEl = document.getElementById("clearProcessedBtn");

    mediaTypeFilterInput.addEventListener("change", async () => {
      await updateSettings({ mediaTypeFilter: mediaTypeFilterInput.value });
    });

    const forceRedownloadCheckboxEl = document.getElementById("forceRedownloadCheckbox");
    forceRedownloadCheckboxEl.addEventListener("change", async () => {
      await updateSettings({ forceRedownload: forceRedownloadCheckboxEl.checked });
    });
    scrollUpCheckboxEl.addEventListener("change", async () => {
      await updateSettings({ scrollDirection: scrollUpCheckboxEl.checked ? "up" : "down" });
    });

    clearProcessedBtnEl.addEventListener("click", async () => {
      if (!confirm(t(currentLang, "confirmClearProcessed"))) return;
      await clearProcessedPostsMemory();
      // ÖNEMLİ: Zaten açık olan Reddit sekmelerindeki butonlar, "bu daha
      // önce indirildi mi" bilgisini sayfa ilk tarandığında sabitliyor —
      // bu temizleme, YENİDEN YÜKLEMEDEN o sekmelere yansımıyor. Kullanıcı
      // bunu görmezse "çalışmıyor" sanabilir, bu yüzden net bir hatırlatma.
      alert(t(currentLang, "clearProcessedRefreshReminder"));
    });

    // --- ÖNEMLİ YENİ ÖZELLİK: Arşiv Yönetimi — işlenmiş gönderi kaydını
    // "hepsini temizle" yerine SADECE seçilen bir subreddit/kullanıcı için
    // temizleyebilme. Kayıtlar artık subreddit/kullanıcı bilgisiyle
    // saklandığı için gruplayıp sayılarıyla gösterebiliyoruz.
    const manageArchiveBtnEl = document.getElementById("manageArchiveBtn");
    const archiveManagerWrapEl = document.getElementById("archiveManagerWrap");
    const archiveTotalTextEl = document.getElementById("archiveTotalText");
    const archiveTabSubredditsBtnEl = document.getElementById("archiveTabSubredditsBtn");
    const archiveTabUsersBtnEl = document.getElementById("archiveTabUsersBtn");
    const archiveListSubredditsEl = document.getElementById("archiveListSubreddits");
    const archiveListUsersEl = document.getElementById("archiveListUsers");

    function renderArchiveGroup(container, items, kind) {
      container.innerHTML = "";
      if (items.length === 0) {
        setEmptyMessage(container, "archive-empty", t(currentLang, "archiveEmpty"));
        return;
      }
      items.forEach(({ name, count }) => {
        const item = document.createElement("div");
        item.className = "sub-item";

        const info = document.createElement("div");
        const nameEl = document.createElement("div");
        nameEl.className = "sub-item-name";
        nameEl.textContent = `${kind === "subreddit" ? "r/" : "u/"}${name}`;
        const metaEl = document.createElement("div");
        metaEl.className = "sub-item-meta";
        metaEl.textContent = `${count} ${t(currentLang, "archiveRecordsUnit")}`;
        info.appendChild(nameEl);
        info.appendChild(metaEl);

        const removeBtn = document.createElement("button");
        removeBtn.className = "sub-remove-btn";
        removeBtn.textContent = "✕";
        removeBtn.title = t(currentLang, "archiveClearThis");
        removeBtn.addEventListener("click", async () => {
          if (!confirm(t(currentLang, "confirmClearArchiveGroup").replace("{name}", name))) return;
          if (kind === "subreddit") {
            await clearProcessedPostsBySubreddit(name);
          } else {
            await clearProcessedPostsByUser(name);
          }
          alert(t(currentLang, "clearProcessedRefreshReminder"));
          await renderArchiveManager();
        });

        item.appendChild(info);
        item.appendChild(removeBtn);
        container.appendChild(item);
      });
    }

    async function renderArchiveManager() {
      const summary = await getProcessedPostsSummary();
      archiveTotalTextEl.textContent = `${t(currentLang, "archiveTotalRecords")}: ${summary.total}`;
      renderArchiveGroup(archiveListSubredditsEl, summary.subreddits, "subreddit");
      renderArchiveGroup(archiveListUsersEl, summary.users, "user");
    }

    manageArchiveBtnEl.addEventListener("click", async () => {
      const isOpen = archiveManagerWrapEl.style.display === "block";
      archiveManagerWrapEl.style.display = isOpen ? "none" : "block";
      if (!isOpen) await renderArchiveManager();
    });

    archiveTabSubredditsBtnEl.addEventListener("click", () => {
      archiveTabSubredditsBtnEl.classList.add("active");
      archiveTabUsersBtnEl.classList.remove("active");
      archiveListSubredditsEl.style.display = "block";
      archiveListUsersEl.style.display = "none";
    });

    archiveTabUsersBtnEl.addEventListener("click", () => {
      archiveTabUsersBtnEl.classList.add("active");
      archiveTabSubredditsBtnEl.classList.remove("active");
      archiveListUsersEl.style.display = "block";
      archiveListSubredditsEl.style.display = "none";
    });

    // Orijinal eklentideki gibi: tarih seçiciler sadece checkbox işaretliyse görünür.
    enableDateFilterInput.addEventListener("change", () => {
      dateRangeFieldsEl.style.display = enableDateFilterInput.checked ? "block" : "none";
    });

    async function loadSettingsIntoForm() {
      const settings = await getSettings();
      folderInput.value = settings.folderDestination;
      filenameInput.value = settings.filenamePattern;
      galleryFoldersInput.checked = settings.useGalleryFolders;
      markDownloadedInput.checked = settings.markDownloaded;
      showDownloadedMarkersInput.checked = settings.showDownloadedMarkers;
      markAsVisitedInput.checked = settings.markAsVisited;
      embedTitleOnImagesInput.checked = settings.embedTitleOnImages;
      embedTitleOnVideosInput.checked = settings.embedTitleOnVideos;
      skipDuplicateMediaInput.checked = settings.skipDuplicateMedia;
      debugLogsInput.checked = !!settings.debugLogs;
      downloadThroughExtensionInput.checked = settings.downloadThroughExtension !== false;
      enableDateFilterInput.checked = settings.enableDateFilter;
      dateRangeFieldsEl.style.display = settings.enableDateFilter ? "block" : "none";
      dateFromInput.value = settings.dateFrom || "";
      dateToInput.value = settings.dateTo || "";

      // Kaydet'in altındaki hızlı seçenekler
      mediaTypeFilterInput.value = settings.mediaTypeFilter || "all";
      scrollUpCheckboxEl.checked = settings.scrollDirection === "up";
      forceRedownloadCheckboxEl.checked = !!settings.forceRedownload;

      // Dil: kayıtlı bir tercih varsa onu kullan, yoksa tarayıcı diline göre
      // otomatik algılanan (currentLang) kalır.
      currentLang = settings.language || currentLang;
      applyTranslations();
      applyTheme(settings.theme || "");
    }

    saveBtnEl.addEventListener("click", async () => {
      await updateSettings({
        folderDestination: folderInput.value.trim() || "Reddit Downloads",
        filenamePattern: filenameInput.value.trim() || "{subreddit}_{timestamp}_{filename}",
        useGalleryFolders: galleryFoldersInput.checked,
        markDownloaded: markDownloadedInput.checked,
        showDownloadedMarkers: showDownloadedMarkersInput.checked,
        markAsVisited: markAsVisitedInput.checked,
        embedTitleOnImages: embedTitleOnImagesInput.checked,
        embedTitleOnVideos: embedTitleOnVideosInput.checked,
        skipDuplicateMedia: skipDuplicateMediaInput.checked,
        debugLogs: debugLogsInput.checked,
        downloadThroughExtension: downloadThroughExtensionInput.checked,
        enableDateFilter: enableDateFilterInput.checked,
        dateFrom: enableDateFilterInput.checked ? dateFromInput.value : "",
        dateTo: enableDateFilterInput.checked ? dateToInput.value : "",
      });
      savedMsgEl.style.display = "block";
      setTimeout(() => (savedMsgEl.style.display = "none"), 2000);
    });

    loadSettingsIntoForm();

    // --- v1.45.4 Yedekleme (dışa/içe aktarma) ---
    const exportBackupBtnEl = document.getElementById("exportBackupBtn");
    const importBackupBtnEl = document.getElementById("importBackupBtn");
    const importBackupFileEl = document.getElementById("importBackupFile");
    const backupMsgEl = document.getElementById("backupMsg");
    function showBackupMsg(text, isError) {
      backupMsgEl.textContent = text;
      backupMsgEl.style.color = isError ? "var(--danger)" : "";
      backupMsgEl.style.display = "block";
      setTimeout(() => (backupMsgEl.style.display = "none"), 6000);
    }
    exportBackupBtnEl.addEventListener("click", async () => {
      try {
        const data = await exportBackup();
        const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
        const date = new Date().toISOString().slice(0, 10);
        const res = await chrome.runtime.sendMessage({ type: "DOWNLOAD_WITH_NAME", url: blobUrl, filename: `GrabPost-backup-${date}.json` });
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        if (!res?.ok) throw new Error(res?.error || "download failed");
        showBackupMsg(`✓ ${t(currentLang, "backupExported")}`);
      } catch (error) {
        log.error("Yedek dışa aktarılamadı:", error);
        showBackupMsg(`⚠ ${t(currentLang, "backupFailed")}`, true);
      }
    });
    importBackupBtnEl.addEventListener("click", () => importBackupFileEl.click());

    // v1.48.1: Chrome'un indirme geçmişinden "indirildi" belleğini ve Geçmiş'i geri kur
    async function runRecoverFromDownloads(showMsg) {
      const r = await chrome.runtime.sendMessage({ type: "RECOVER_FROM_DOWNLOADS" });
      if (!r?.ok) {
        showMsg(`⚠ ${t(currentLang, "backupFailed")}`, true);
        return r;
      }
      showMsg(`✓ ${tf(currentLang, "recoverDownloadsDone", { posts: r.downloadedAdded, history: r.historyAdded, legacy: r.legacy })}`);
      renderHistory();
      return r;
    }
    document.getElementById("recoverDownloadsBtn").addEventListener("click", () => runRecoverFromDownloads(showBackupMsg));

    // v1.48.2: otomatik yedek ayarı (anında kaydedilir) ve son yedek bilgisi
    const autoBackupInput = document.getElementById("autoBackup");
    const lastAutoBackupTextEl = document.getElementById("lastAutoBackupText");
    async function renderAutoBackupInfo() {
      const settings = await getSettings();
      autoBackupInput.checked = settings.autoBackup !== false;
      const { lastAutoBackup } = await chrome.storage.local.get("lastAutoBackup");
      lastAutoBackupTextEl.textContent = lastAutoBackup
        ? `${t(currentLang, "lastAutoBackup")}: ${formatRelativeTime(lastAutoBackup.at)} · ${lastAutoBackup.file}`
        : t(currentLang, "noAutoBackupYet");
    }
    autoBackupInput.addEventListener("change", async () => {
      await updateSettings({ autoBackup: autoBackupInput.checked });
      if (autoBackupInput.checked) await chrome.runtime.sendMessage({ type: "RUN_AUTO_BACKUP" });
      renderAutoBackupInfo();
    });
    renderAutoBackupInfo();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.lastAutoBackup) renderAutoBackupInfo();
    });
    importBackupFileEl.addEventListener("change", async () => {
      const file = importBackupFileEl.files?.[0];
      importBackupFileEl.value = "";
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const r = await importBackup(data);
        showBackupMsg(`✓ ${tf(currentLang, "backupImported", { subs: r.subscriptionsAdded, posts: r.downloadedAdded, history: r.historyAdded })}`);
        await loadSettingsIntoForm();
        renderHistory();
        renderSubscriptions();
      } catch (error) {
        log.warn("Yedek içe aktarılamadı:", error);
        showBackupMsg(`⚠ ${t(currentLang, "backupInvalid")}`, true);
      }
    });

    // --- Toplu indirme ---
    const bulkBtnEl = document.getElementById("bulkBtn");
    const bulkProgressEl = document.getElementById("bulkProgress");
    const stopBtnEl = document.getElementById("stopBtn");
    const progressWrapEl = document.getElementById("progressWrap");
    const progressTextEl = document.getElementById("progressText");
    const progressPercentEl = document.getElementById("progressPercent");
    const progressBarInnerEl = document.getElementById("progressBarInner");
    const progressDetailEl = document.getElementById("progressDetail");

    function updateProgressUI({ phase, completed, total, currentIndex, currentSubreddit }) {
      if (phase === "scrolling") {
        progressWrapEl.style.display = "block";
        progressTextEl.textContent = t(currentLang, "scanningText");
        progressPercentEl.textContent = "";
        progressBarInnerEl.style.width = "0%";
        progressDetailEl.textContent = "";
        return;
      }

      if (phase === "downloading") {
        progressWrapEl.style.display = "block";
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        // ÖNEMLİ: Bu sayaç GÖNDERİ (post) sayısıdır, indirilen dosya sayısı
        // değil — bir galeri gönderisi tek "post" olarak sayılır ama içinde
        // birden fazla dosya indirebilir. Karışıklık olmasın diye açıkça
        // "gönderi" yazıyoruz.
        progressTextEl.textContent = `${completed} / ${total} ${t(currentLang, "postsUnit")}`;
        progressPercentEl.textContent = formatPercent(percent);
        progressBarInnerEl.style.width = `${percent}%`;
        if (currentIndex) {
          const subredditPart = currentSubreddit ? ` • r/${currentSubreddit}` : "";
          progressDetailEl.textContent = `${t(currentLang, "downloadingItem")} ${currentIndex}/${total}${subredditPart}`;
        }
        return;
      }

      if (phase === "finished" || phase === "stopped") {
        const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
        progressBarInnerEl.style.width = `${percent}%`;
        progressTextEl.textContent = `${completed} / ${total} ${t(currentLang, "postsUnit")}`;
        progressPercentEl.textContent = formatPercent(percent);
        progressDetailEl.textContent = "";

        bulkBtnEl.disabled = false;
        bulkBtnEl.style.display = "block";
        stopBtnEl.style.display = "none";

        setTimeout(() => {
          progressWrapEl.style.display = "none";
        }, 5000);
      }
    }

    // İçerik betiğinden (content.js) gelen ilerleme mesajlarını dinliyoruz.
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "BULK_PROGRESS") {
        updateProgressUI(message);
      }
    });

    bulkBtnEl.addEventListener("click", async () => {
      const tab = await getTargetTab();
      if (!tab?.url?.includes("reddit.com")) {
        bulkProgressEl.textContent = t(currentLang, "panelNotRedditTab");
        return;
      }

      bulkBtnEl.disabled = true;
      bulkBtnEl.style.display = "none";
      stopBtnEl.style.display = "block";
      bulkProgressEl.textContent = "";

      try {
        await chrome.tabs.sendMessage(tab.id, { type: "BULK_DOWNLOAD" });
      } catch (error) {
        const isConnectionError = String(error?.message || "").includes("Could not establish connection");
        // ÖNEMLİ DÜZELTME: Bu durum (content.js henüz o sekmede yüklenmemiş)
        // zaten kullanıcıya net bir mesajla ("sekmeyi yenileyin") bildiriliyor
        // — gerçek, beklenmedik bir hata değil. log.error() çağırmak,
        // Chrome'un uzantı hata sayacına eklenmesine sebep oluyordu, bu da
        // kullanıcıyı gereksiz yere "bir şey bozuldu" sanmasına yol açıyordu.
        // Sadece GERÇEKTEN beklenmedik hatalarda console.error kullanıyoruz.
        if (isConnectionError) {
          log.warn("Bulk indirme: content.js henüz bu sekmede aktif değil (sekme yenilenmeli).");
        } else {
          log.error(error);
        }
        bulkProgressEl.textContent = isConnectionError
          ? t(currentLang, "panelReloadTab")
          : t(currentLang, "panelGenericError");
        bulkBtnEl.disabled = false;
        bulkBtnEl.style.display = "block";
        stopBtnEl.style.display = "none";
        if (!isConnectionError) {
          setTimeout(() => (bulkProgressEl.textContent = ""), 4000);
        }
      }
    });

    // --- v1.46.0 Hızlı mod (API) ve Kaydedilenler ---
    const apiBulkBtnEl = document.getElementById("apiBulkBtn");
    const savedBulkBtnEl = document.getElementById("savedBulkBtn");
    const apiBulkLimitEl = document.getElementById("apiBulkLimit");
    let activeBulkMode = "page"; // "page" (sayfa kaydırmalı) | "api" (hızlı mod)

    function setApiBulkRunning(running) {
      apiBulkBtnEl.disabled = running;
      savedBulkBtnEl.disabled = running;
      apiBulkLimitEl.disabled = running;
      if (running) {
        activeBulkMode = "api";
        bulkBtnEl.style.display = "none";
        stopBtnEl.style.display = "block";
      }
    }

    function apiBulkErrorText(code) {
      if (code === "NOT_LOGGED_IN") return t(currentLang, "apiBulkNotLoggedIn");
      if (code === "NOT_LISTING") return t(currentLang, "apiBulkNotListing");
      if (code === "RUNNING") return t(currentLang, "apiBulkRunning");
      return t(currentLang, "panelGenericError");
    }

    async function startApiBulk(source) {
      const tab = await getTargetTab();
      const res = await chrome.runtime.sendMessage({ type: "API_BULK_START", source, url: tab?.url || "", maxPosts: Number(apiBulkLimitEl.value) });
      if (!res?.ok) {
        bulkProgressEl.textContent = apiBulkErrorText(res?.error);
        setTimeout(() => (bulkProgressEl.textContent = ""), 6000);
        return;
      }
      bulkProgressEl.textContent = `⚡ ${res.label}`;
      setApiBulkRunning(true);
    }
    apiBulkBtnEl.addEventListener("click", () => startApiBulk("page"));
    savedBulkBtnEl.addEventListener("click", () => startApiBulk("saved"));

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "API_BULK_PROGRESS") return;
      setApiBulkRunning(message.phase !== "finished" && message.phase !== "stopped");
      updateProgressUI(message);
      if (message.phase === "finished" || message.phase === "stopped") {
        activeBulkMode = "page";
        const reasonKey = { reached_downloaded: "apiBulkReachedDownloaded", limit: "apiBulkReachedLimit", age_restricted: "subAgeRestricted", rate_limited: "apiBulkRateLimited" }[message.stopReason];
        const summary = tf(currentLang, "apiBulkSummary", { scanned: message.scanned || 0, skipped: message.skippedDownloaded || 0 });
        bulkProgressEl.textContent = reasonKey ? `${summary} · ${t(currentLang, reasonKey)}` : summary;
        setTimeout(() => (bulkProgressEl.textContent = ""), 10000);
      }
    });

    // Panel kapatılıp açıldıysa ve hızlı mod hâlâ çalışıyorsa durumu geri getir.
    chrome.runtime.sendMessage({ type: "API_BULK_STATUS" }).then((st) => {
      if (st?.running) {
        setApiBulkRunning(true);
        if (st.last) updateProgressUI(st.last);
      }
    }).catch(() => {});

    stopBtnEl.addEventListener("click", async () => {
      if (activeBulkMode === "api") {
        await chrome.runtime.sendMessage({ type: "API_BULK_STOP" });
        return;
      }
      const tab = await getTargetTab();
      if (!tab?.id) return;
      stopBtnEl.disabled = true;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "STOP_BULK_DOWNLOAD" });
      } catch (error) {
        // Aynı düzeltme: sekme kapanmış/yenilenmişse bu beklenen bir durum,
        // gerçek bir hata değil — sadece console.warn kullanıyoruz.
        if (String(error?.message || "").includes("Could not establish connection")) {
          log.warn("Durdurma: content.js bu sekmede artık aktif değil (muhtemelen sekme kapandı/yenilendi).");
        } else {
          log.error(error);
        }
      } finally {
        stopBtnEl.disabled = false;
      }
    });

    // --- Takip (abonelik) sekmesi ---
    const subTypeSelectEl = document.getElementById("subTypeSelect");
    const subNameInputEl = document.getElementById("subNameInput");
    const addSubBtnEl = document.getElementById("addSubBtn");
    const subsListContainerEl = document.getElementById("subsListContainer");
    const intervalSliderEl = document.getElementById("intervalSlider");
    const intervalValueTextEl = document.getElementById("intervalValueText");
    const downloadAllPendingBtnEl = document.getElementById("downloadAllPendingBtn");
    const stopAllPendingBtnEl = document.getElementById("stopAllPendingBtn");
    const pendingProgressWrapEl = document.getElementById("pendingProgressWrap");
    const pendingProgressTextEl = document.getElementById("pendingProgressText");
    const pendingProgressPercentEl = document.getElementById("pendingProgressPercent");
    const pendingProgressBarInnerEl = document.getElementById("pendingProgressBarInner");
    const pendingProgressDetailEl = document.getElementById("pendingProgressDetail");

    function updatePendingProgressUI({ phase, completed, total, currentSubreddit }) {
      if (phase === "downloading") {
        pendingProgressWrapEl.style.display = "block";
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        pendingProgressTextEl.textContent = `${completed} / ${total}`;
        pendingProgressPercentEl.textContent = formatPercent(percent);
        pendingProgressBarInnerEl.style.width = `${percent}%`;
        if (currentSubreddit) {
          pendingProgressDetailEl.textContent = `${t(currentLang, "downloadingItem")} r/${currentSubreddit}...`;
        }
        return;
      }
      if (phase === "finished" || phase === "stopped") {
        pendingProgressDetailEl.textContent = "";
        downloadAllPendingBtnEl.disabled = false;
        stopAllPendingBtnEl.style.display = "none";
        setTimeout(() => {
          pendingProgressWrapEl.style.display = "none";
        }, 4000);
        renderSubscriptions(); // rozet sayıları ve kalan bekleyenleri tazele
      }
    }

    // İçerik/arka plandan gelen ilerleme mesajlarını dinliyoruz.
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "PENDING_DOWNLOAD_PROGRESS") updatePendingProgressUI(message);
    });

    downloadAllPendingBtnEl.addEventListener("click", async () => {
      downloadAllPendingBtnEl.disabled = true;
      downloadAllPendingBtnEl.style.display = "none";
      stopAllPendingBtnEl.style.display = "block";
      try {
        await chrome.runtime.sendMessage({ type: "DOWNLOAD_ALL_PENDING" });
      } catch (error) {
        log.error(error);
        downloadAllPendingBtnEl.disabled = false;
        downloadAllPendingBtnEl.style.display = "block";
        stopAllPendingBtnEl.style.display = "none";
      }
    });

    stopAllPendingBtnEl.addEventListener("click", async () => {
      stopAllPendingBtnEl.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: "STOP_DOWNLOAD_ALL_PENDING" });
      } catch (error) {
        log.error(error);
      } finally {
        stopAllPendingBtnEl.disabled = false;
        downloadAllPendingBtnEl.style.display = "block";
      }
    });

    // v1.45.0: 30 dk ve 1 saat seçenekleri eklendi (saat cinsinden). Chrome
    // alarmları 30 sn'ye kadar izin veriyor; 30 dk'dan kısası Reddit'e
    // gereksiz yük ve IP kısıtlaması riski demek, bu yüzden alt sınır 30 dk.
    const INTERVAL_STEPS = [0.5, 1, 2, 4, 8, 12, 24];
    function formatInterval(hours) {
      return hours < 1 ? `${Math.round(hours * 60)} ${t(currentLang, "minutesSuffix")}` : `${hours} ${t(currentLang, "hoursSuffix")}`;
    }

    function formatLastChecked(timestamp) {
      if (!timestamp) return t(currentLang, "subNeverChecked");
      const diffMin = Math.floor((Date.now() - timestamp) / 60000);
      if (diffMin < 1) return t(currentLang, "subJustChecked");
      if (diffMin < 60) return `${diffMin} ${t(currentLang, "minShort")}`;
      const diffHour = Math.floor(diffMin / 60);
      return `${diffHour} ${t(currentLang, "hourShort")}`;
    }

    // ÖNEMLİ: Bu değişkenler renderSubscriptions() DIŞINDA, kararlı bir
    // kapsamda tutuluyor — panel bir sürükleme sırasında (ör. arka planda
    // bir Takip kontrolü tamamlanıp liste yeniden render edilirse) tekrar
    // çizilse bile sürükleme durumu kaybolmasın diye.
    let draggedSubId = null;
    let draggedSubType = null;
    let dragStartOrder = null;
    let renderPendingAfterDrag = false;
    function currentDomOrder() {
      return Array.from(subsListContainerEl.querySelectorAll(".sub-item")).map((el) => el.dataset.subId);
    }

    // v1.45.5: açık filtre panelleri (liste yeniden çizilince kapanmasın diye)
    const openFilterPanels = new Set();

    function buildFilterPanel(sub) {
      const panel = document.createElement("div");
      panel.className = "sub-filter-panel";
      panel.draggable = false;
      panel.addEventListener("dragstart", (e) => e.preventDefault());
      const makeSelect = (labelKey, value, options, field) => {
        const label = document.createElement("label");
        label.textContent = t(currentLang, labelKey);
        const sel = document.createElement("select");
        for (const [val, key] of options) {
          const o = document.createElement("option");
          o.value = val;
          o.textContent = t(currentLang, key);
          sel.appendChild(o);
        }
        sel.value = value || "all";
        sel.addEventListener("change", () => updateSubscription(sub.id, { [field]: sel.value }));
        panel.append(label, sel);
      };
      makeSelect("subFilterMedia", sub.filterMedia, [["all", "subFilterAll"], ["images", "subFilterImages"], ["videos", "subFilterVideos"]], "filterMedia");
      makeSelect("subFilterNsfw", sub.filterNsfw, [["all", "subFilterAll"], ["only", "subFilterNsfwOnly"], ["skip", "subFilterNsfwSkip"]], "filterNsfw");
      const kwLabel = document.createElement("label");
      kwLabel.textContent = t(currentLang, "subFilterKeywords");
      const kwInput = document.createElement("input");
      kwInput.type = "text";
      kwInput.value = sub.filterKeywords || "";
      kwInput.placeholder = t(currentLang, "subFilterKeywordsPlaceholder");
      kwInput.addEventListener("change", () => updateSubscription(sub.id, { filterKeywords: kwInput.value.trim() }));
      panel.append(kwLabel, kwInput);
      return panel;
    }

    async function renderSubscriptions() {
      // v1.47.1: Sürükleme sürerken (ör. arka planda otomatik kontrol depoyu
      // güncellerse) listeyi yeniden çizmek sürüklemeyi bozuyordu; çizimi
      // sürükleme bitene kadar ertele.
      if (draggedSubId) {
        renderPendingAfterDrag = true;
        return;
      }
      const subs = await getSubscriptions();
      subsListContainerEl.innerHTML = "";

      const totalPending = subs.reduce((sum, s) => sum + (s.pendingPosts?.length || 0), 0);
      // ÖNEMLİ: Aktif bir "tümünü indir" çalışması varsa (durdur butonu
      // görünürken) bu görünürlüğü EZMEYELİM — yoksa arka planda indirme
      // devam ederken buton yanlışlıkla tekrar "İndir" moduna dönebilirdi.
      const isDownloadingAll = stopAllPendingBtnEl.style.display === "block";
      if (!isDownloadingAll) {
        downloadAllPendingBtnEl.style.display = totalPending > 0 ? "block" : "none";
      }
      downloadAllPendingBtnEl.textContent = `⬇ ${t(currentLang, "downloadAllPending")} (${totalPending})`;

      if (subs.length === 0) {
        setEmptyMessage(subsListContainerEl, "empty-state", t(currentLang, "subsEmpty"));
        return;
      }

      function renderSubItem(sub) {
        const item = document.createElement("div");
        item.className = "sub-item";
        // ÖNEMLİ YENİ ÖZELLİK: Sürükle-bırak ile yeniden sıralama. Kartın
        // kendisini sürüklenebilir yapıyoruz — ayrı bir "tutamaç" simgesi
        // gerekmiyor, kullanıcı kartın herhangi bir boş noktasından tutup
        // sürükleyebiliyor (butonlara tıklamak normal şekilde çalışmaya
        // devam ediyor, HTML5 sürükleme sadece gerçek bir fare hareketiyle
        // tetikleniyor).
        item.draggable = true;
        item.dataset.subId = sub.id;
        item.dataset.subType = sub.type;

        const pendingCount = sub.pendingPosts?.length || 0;

        // ÖNEMLİ YENİ EKLEME: Kartın sürüklenebilir olduğunu gösteren
        // görsel bir tutamaç simgesi — önceden hiçbir işaret olmadığı
        // için kullanıcı bunun mümkün olduğunu fark edemiyordu.
        const dragHandle = document.createElement("span");
        dragHandle.className = "sub-drag-handle";
        dragHandle.textContent = "⠿";
        dragHandle.title = t(currentLang, "dragToReorder");
        item.appendChild(dragHandle);

        const info = document.createElement("div");
        info.className = "sub-item-info";
        const nameEl = document.createElement("div");
        nameEl.className = "sub-item-name";
        nameEl.textContent = `${sub.type === "subreddit" ? "r/" : "u/"}${sub.name}`;
        // ÖNEMLİ YENİ ÖZELLİK: İsme tıklayınca o subreddit/kullanıcı
        // sayfasını yeni bir sekmede açar — panelden ayrılmadan hızlıca
        // sayfaya göz atabilmek için.
        nameEl.style.cursor = "pointer";
        nameEl.title = t(currentLang, "openInNewTab");
        nameEl.addEventListener("click", () => {
          const url =
            sub.type === "subreddit"
              ? `https://www.reddit.com/r/${sub.name}/new/`
              : `https://www.reddit.com/user/${sub.name}/submitted/`;
          chrome.tabs.create({ url });
        });
        if (pendingCount > 0) {
          const badge = document.createElement("span");
          badge.className = "sub-pending-badge";
          badge.textContent = `🆕 ${pendingCount}`;
          nameEl.appendChild(badge);
        }
        const metaEl = document.createElement("div");
        metaEl.className = "sub-item-meta";
        if (sub.lastError === "age_restricted") {
          metaEl.textContent = `⚠️ ${t(currentLang, "subAgeRestricted")}`;
          metaEl.style.color = "var(--danger)";
        } else if (sub.lastError === "http_429") {
          metaEl.textContent = `⏳ ${t(currentLang, "subLastChecked")}: ${formatLastChecked(sub.lastCheckedAt)} (${t(currentLang, "subRateLimited")})`;
          metaEl.style.color = "var(--danger)";
        } else if (sub.lastError) {
          metaEl.textContent = `⚠️ ${t(currentLang, "subLastChecked")}: ${formatLastChecked(sub.lastCheckedAt)} (${sub.lastError})`;
          metaEl.style.color = "var(--danger)";
        } else {
          metaEl.textContent = `${t(currentLang, "subLastChecked")}: ${formatLastChecked(sub.lastCheckedAt)}`;
        }
        info.appendChild(nameEl);
        info.appendChild(metaEl);

        const actions = document.createElement("div");
        actions.className = "sub-item-actions";

        // Kanal bazlı indirme butonu: sadece bekleyen yeni medya varsa aktif.
        const downloadBtn = document.createElement("button");
        downloadBtn.className = pendingCount > 0 ? "sub-download-btn active" : "sub-download-btn";
        downloadBtn.textContent = "⬇";
        downloadBtn.disabled = pendingCount === 0;
        downloadBtn.title = pendingCount > 0 ? t(currentLang, "downloadThisSub") : t(currentLang, "noPendingMedia");
        downloadBtn.addEventListener("click", async () => {
          downloadBtn.disabled = true;
          try {
            await chrome.runtime.sendMessage({ type: "DOWNLOAD_SUBSCRIPTION_PENDING", subscriptionId: sub.id });
            await renderSubscriptions();
          } catch (error) {
            log.error(error);
            downloadBtn.disabled = false;
          }
        });
        actions.appendChild(downloadBtn);

        // ÖNEMLİ TASARIM DÜZELTMESİ: Manuel indirme butonu ile aşağıdaki
        // iki anahtar, görsel olarak birbirine çok yakın/karışık
        // duruyordu — "hangisi ne yapıyor" belirsizdi. Aralarına ince bir
        // ayraç (seperatör) koyduk: sol taraf "bu anki bekleyen medyayı
        // indir" (tek seferlik eylem), sağ taraf "bundan sonra nasıl
        // davranılsın" (kalıcı ayarlar) — iki farklı kategori net şekilde
        // ayrışıyor.
        const sep1 = document.createElement("span");
        sep1.className = "sub-actions-sep";
        actions.appendChild(sep1);

        // ÖNEMLİ TASARIM DEĞİŞİKLİĞİ: Anahtar (toggle) yerine "chip"
        // (buton gibi bas-değiştir) tasarımına geçtik — iki kontrol de
        // BİRBİRİNDEN BAĞIMSIZ (biri açık biri kapalı, ikisi de açık,
        // ikisi de kapalı — hepsi geçerli kombinasyon), bu yüzden anahtar
        // görünümü "birini seç" izlenimi verip kafa karıştırabiliyordu.
        // Chip'ler bunu net şekilde iki ayrı, bağımsız kontrol olarak
        // gösteriyor.
        const chipGroup = document.createElement("div");
        chipGroup.className = "sub-chip-group";

        // v1.50.0: Favori (★): daha sık kontrol edilir, en fazla MAX_FAVORITES kaynak.
        const favChip = document.createElement("button");
        favChip.className = sub.favorite ? "sub-chip sub-chip-fav active" : "sub-chip sub-chip-fav";
        favChip.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
        favChip.title = t(currentLang, "favoriteHint");
        favChip.addEventListener("click", async () => {
          const next = !sub.favorite;
          const r = await setSubscriptionFavorite(sub.id, next);
          if (!r.ok) {
            showFollowMsg(`⚠ ${tf(currentLang, "favoriteLimit", { max: MAX_FAVORITES })}`, true);
            return;
          }
          await renderSubscriptions();
          updateFavoriteInfo();
        });
        chipGroup.appendChild(favChip);

        const checkChip = document.createElement("button");
        checkChip.className = sub.enabled ? "sub-chip active" : "sub-chip";
        checkChip.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"></circle><line x1="21" y1="21" x2="15" y2="15"></line></svg>';
        checkChip.title = t(currentLang, "toggleCheckHint");
        checkChip.addEventListener("click", async () => {
          const next = !sub.enabled;
          checkChip.classList.toggle("active", next);
          await updateSubscription(sub.id, { enabled: next });
        });
        chipGroup.appendChild(checkChip);

        const autoChip = document.createElement("button");
        autoChip.className = sub.autoDownload ? "sub-chip active sub-chip-auto" : "sub-chip sub-chip-auto";
        autoChip.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 3 4 14 12 14 11 21 20 10 12 10 13 3"></polygon></svg>';
        autoChip.title = t(currentLang, "autoDownloadHint");
        autoChip.addEventListener("click", async () => {
          const next = !sub.autoDownload;
          autoChip.classList.toggle("active", next);
          await updateSubscription(sub.id, { autoDownload: next });
        });
        chipGroup.appendChild(autoChip);

        // v1.45.5: filtre chip'i: kaynağa özel medya türü / NSFW / anahtar kelime filtresi
        const hasFilter = (sub.filterMedia && sub.filterMedia !== "all") || (sub.filterNsfw && sub.filterNsfw !== "all") || !!sub.filterKeywords;
        const filterChip = document.createElement("button");
        filterChip.className = hasFilter ? "sub-chip sub-chip-filter active" : "sub-chip sub-chip-filter";
        filterChip.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>';
        filterChip.title = t(currentLang, "subFilterHint");
        filterChip.addEventListener("click", () => {
          if (openFilterPanels.has(sub.id)) openFilterPanels.delete(sub.id);
          else openFilterPanels.add(sub.id);
          renderSubscriptions();
        });
        chipGroup.appendChild(filterChip);

        actions.appendChild(chipGroup);

        const sep2 = document.createElement("span");
        sep2.className = "sub-actions-sep";
        actions.appendChild(sep2);

        const removeBtn = document.createElement("button");
        removeBtn.className = "sub-remove-btn";
        removeBtn.textContent = "✕";
        removeBtn.addEventListener("click", async () => {
          await removeSubscription(sub.id);
          renderSubscriptions();
        });
        actions.appendChild(removeBtn);

        item.appendChild(info);
        item.appendChild(actions);

        if (openFilterPanels.has(sub.id)) {
          item.classList.add("has-filter-panel");
          item.appendChild(buildFilterPanel(sub));
        }

        item.addEventListener("dragstart", (e) => {
          draggedSubId = sub.id;
          draggedSubType = sub.type;
          dragStartOrder = currentDomOrder();
          item.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
        });
        /**
         * v1.47.1 SIRALAMA DÜZELTMESİ: Yeni sıra önceden sadece "drop"
         * olayında kaydediliyordu. Ama kart sürüklenirken imlecin altına
         * taşındığı için bırakma anında imleç çoğunlukla sürüklenen kartın
         * KENDİ üstünde oluyor; orada bırakmaya izin verilmediği için "drop"
         * hiç tetiklenmiyor, sıra ekranda değişmiş görünüp HİÇ
         * kaydedilmiyordu. İlk otomatik kontrol listeyi yeniden çizince eski
         * sıra geri geliyordu. Artık sıra, her sürüklemenin sonunda kesin
         * gelen "dragend" olayında kaydediliyor.
         */
        item.addEventListener("dragend", async () => {
          item.classList.remove("dragging");
          draggedSubId = null;
          draggedSubType = null;
          const orderedIds = currentDomOrder();
          const changed = orderedIds.join("|") !== (dragStartOrder || []).join("|");
          dragStartOrder = null;
          if (changed) await reorderSubscriptions(orderedIds);
          if (renderPendingAfterDrag) {
            renderPendingAfterDrag = false;
            renderSubscriptions();
          }
        });
        item.addEventListener("dragover", (e) => {
          // ÖNEMLİ: Yeniden sıralama sadece AYNI tür (subreddit/kullanıcı)
          // kartları arasında anlamlı — iki ayrı grup birbirine karışmasın.
          if (draggedSubType !== sub.type) return;
          e.preventDefault(); // kartın kendi üstü dahil: bırakmaya izin ver
          if (draggedSubId === sub.id) return;
          const draggingEl = subsListContainerEl.querySelector(".sub-item.dragging");
          if (!draggingEl || draggingEl === item) return;
          const rect = item.getBoundingClientRect();
          const isAfter = e.clientY - rect.top > rect.height / 2;
          item.parentNode.insertBefore(draggingEl, isAfter ? item.nextSibling : item);
        });
        item.addEventListener("drop", (e) => {
          e.preventDefault(); // kaydetme dragend'de yapılıyor (bkz. yukarısı)
        });

        return item;
      }

      // ÖNEMLİ: r/ ve u/ karışık gelmesin diye iki ayrı grupta gösteriyoruz.
      const subreddits = subs.filter((s) => s.type === "subreddit");
      const users = subs.filter((s) => s.type === "user");

      if (subreddits.length > 0) {
        const title = document.createElement("div");
        title.className = "sub-group-title";
        title.textContent = `${t(currentLang, "subGroupSubreddits")} (${subreddits.length})`;
        subsListContainerEl.appendChild(title);
        subreddits.forEach((sub) => subsListContainerEl.appendChild(renderSubItem(sub)));
      }

      if (users.length > 0) {
        const title = document.createElement("div");
        title.className = "sub-group-title";
        title.textContent = `${t(currentLang, "subGroupUsers")} (${users.length})`;
        subsListContainerEl.appendChild(title);
        users.forEach((sub) => subsListContainerEl.appendChild(renderSubItem(sub)));
      }
    }

    addSubBtnEl.addEventListener("click", async () => {
      const name = subNameInputEl.value.trim();
      if (!name) return;
      await addSubscription(subTypeSelectEl.value, name);
      subNameInputEl.value = "";
      renderSubscriptions();
    });

    subNameInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addSubBtnEl.click();
    });

    // --- v1.47.4 Yapıştırma ve "açık sayfayı ekle" ---
    /** Ayrıştırılmış kaynağı giriş alanına yerleştirir (tür seçimini de günceller). */
    function fillSubInput(text) {
      const parsed = parseFollowEntry(text);
      if (!parsed) {
        subNameInputEl.value = String(text || "").trim();
        return false;
      }
      if (parsed.type) subTypeSelectEl.value = parsed.type;
      subNameInputEl.value = parsed.name;
      return true;
    }
    // Ctrl+V çalıştığında: tam Reddit adresi yapıştırılırsa adı ve türü ayıkla.
    subNameInputEl.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") || "";
      if (/reddit\.com\/|^\/?(r|u|user)\//i.test(text.trim())) {
        e.preventDefault();
        fillSubInput(text);
      }
    });
    // Tıklayınca panel penceresini de odakla (klavye adres çubuğunda kalmasın).
    subNameInputEl.addEventListener("pointerdown", () => {
      try {
        window.focus();
      } catch {
        /* zararsız */
      }
    });

    /**
     * 📋 Yapıştır düğmesi: Chrome'un yan paneli bazı durumlarda klavye
     * odağını almıyor ve Ctrl+V adres çubuğuna gidiyor (tarayıcı davranışı).
     * Bu düğme panoyu doğrudan okur. Panoya erişim izni ("clipboardRead")
     * kurulumda istenmiyor (güncellemede eklentiyi devre dışı bırakırdı);
     * düğmeye ilk basışta bir kez soruluyor.
     */
    const pasteSubBtnEl = document.getElementById("pasteSubBtn");
    pasteSubBtnEl.addEventListener("click", async () => {
      try {
        const granted = await chrome.permissions.request({ permissions: ["clipboardRead"] });
        if (!granted) return;
        let text = "";
        try {
          text = await navigator.clipboard.readText();
        } catch {
          // Panel odakta değilse tarayıcı okumaya izin vermiyor; arka plandan oku.
          const res = await chrome.runtime.sendMessage({ type: "READ_CLIPBOARD" });
          text = res?.text || "";
        }
        if (!text.trim()) {
          showFollowMsg(`⚠ ${t(currentLang, "pasteEmpty")}`, true);
          return;
        }
        fillSubInput(text);
        subNameInputEl.focus();
      } catch (error) {
        log.warn("Pano okunamadı:", error);
        showFollowMsg(`⚠ ${t(currentLang, "pasteEmpty")}`, true);
      }
    });

    /** ➕ Açık sayfayı ekle: hedef Reddit sekmesinin adresinden subreddit/kullanıcıyı alıp ekler. */
    const addCurrentPageBtnEl = document.getElementById("addCurrentPageBtn");
    async function refreshAddCurrentPageBtn() {
      const tab = await getTargetTab().catch(() => null);
      const parsed = tab?.url ? parseFollowEntry(tab.url) : null;
      const ok = !!(parsed?.type && /reddit\.com/i.test(tab.url));
      // Zaten takip ediliyorsa gösterme.
      const already = ok && (await getSubscriptions()).some((x) => x.id === `${parsed.type}:${parsed.name.toLowerCase()}`);
      addCurrentPageBtnEl.style.display = ok && !already ? "block" : "none";
      if (ok) addCurrentPageBtnEl.textContent = `➕ ${parsed.type === "subreddit" ? "r/" : "u/"}${parsed.name} — ${t(currentLang, "addCurrentPage")}`;
    }
    addCurrentPageBtnEl.addEventListener("click", async () => {
      const tab = await getTargetTab();
      const parsed = tab?.url ? parseFollowEntry(tab.url) : null;
      if (!parsed?.type) return;
      await addSubscription(parsed.type, parsed.name);
      renderSubscriptions();
      refreshAddCurrentPageBtn();
      showFollowMsg(`✓ ${parsed.type === "subreddit" ? "r/" : "u/"}${parsed.name}`);
    });
    refreshAddCurrentPageBtn();
    chrome.tabs.onActivated.addListener(() => refreshAddCurrentPageBtn());
    chrome.tabs.onUpdated.addListener((_id, info) => {
      if (info.url) refreshAddCurrentPageBtn();
    });

    // --- v1.47.2 Takip listesi dışa/içe aktarma ---
    const exportFollowBtnEl = document.getElementById("exportFollowBtn");
    const importFollowBtnEl = document.getElementById("importFollowBtn");
    const importFollowFileEl = document.getElementById("importFollowFile");
    const followMsgEl = document.getElementById("followMsg");
    function showFollowMsg(text, isError) {
      followMsgEl.textContent = text;
      followMsgEl.style.color = isError ? "var(--danger)" : "var(--text-secondary)";
      followMsgEl.style.display = "block";
      setTimeout(() => (followMsgEl.style.display = "none"), 7000);
    }
    exportFollowBtnEl.addEventListener("click", async () => {
      try {
        const data = await exportFollowList();
        if (!data.items.length) {
          showFollowMsg(t(currentLang, "subsEmpty"), true);
          return;
        }
        const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        const date = new Date().toISOString().slice(0, 10);
        const res = await chrome.runtime.sendMessage({ type: "DOWNLOAD_WITH_NAME", url: blobUrl, filename: `GrabPost-follow-list-${date}.json` });
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        if (!res?.ok) throw new Error(res?.error || "download failed");
        showFollowMsg(`✓ ${tf(currentLang, "followExported", { n: data.items.length })}`);
      } catch (error) {
        log.error("Takip listesi dışa aktarılamadı:", error);
        showFollowMsg(`⚠ ${t(currentLang, "backupFailed")}`, true);
      }
    });
    importFollowBtnEl.addEventListener("click", () => importFollowFileEl.click());
    importFollowFileEl.addEventListener("change", async () => {
      const file = importFollowFileEl.files?.[0];
      importFollowFileEl.value = "";
      if (!file) return;
      try {
        const r = await importFollowList(await file.text(), subTypeSelectEl.value);
        if (!r.added && !r.skipped) throw new Error("empty");
        showFollowMsg(`✓ ${tf(currentLang, "followImported", { added: r.added, skipped: r.skipped, invalid: r.invalid })}`);
        renderSubscriptions();
      } catch (error) {
        log.warn("Takip listesi içe aktarılamadı:", error);
        showFollowMsg(`⚠ ${t(currentLang, "followImportInvalid")}`, true);
      }
    });

    intervalSliderEl.addEventListener("input", () => {
      intervalValueTextEl.textContent = formatInterval(INTERVAL_STEPS[intervalSliderEl.value]);
    });
    intervalSliderEl.addEventListener("change", async () => {
      await updateSettings({ checkIntervalHours: INTERVAL_STEPS[intervalSliderEl.value] });
      setTimeout(updateNextCheckText, 500); // background'ın alarmı yeniden kurması için kısa bekleme
    });

    // --- v1.50.0 Favori kontrol sıklığı ---
    const favoriteIntervalEl = document.getElementById("favoriteInterval");
    const favoriteInfoEl = document.getElementById("favoriteInfo");
    favoriteIntervalEl.addEventListener("change", async () => {
      await updateSettings({ favoriteIntervalMinutes: Number(favoriteIntervalEl.value) });
      setTimeout(updateNextCheckText, 500);
    });
    async function updateFavoriteInfo() {
      const subs = await getSubscriptions();
      const n = subs.filter((s) => s.favorite).length;
      favoriteInfoEl.textContent = tf(currentLang, "favoriteCountHint", { n, max: MAX_FAVORITES });
    }

    async function loadIntervalSlider() {
      const s0 = await getSettings();
      favoriteIntervalEl.value = String(s0.favoriteIntervalMinutes || 15);
      [...favoriteIntervalEl.options].forEach((o) => (o.textContent = `${o.value} ${t(currentLang, "minutesSuffix")}`));
      updateFavoriteInfo();
      const settings = await getSettings();
      const idx = Math.max(INTERVAL_STEPS.indexOf(settings.checkIntervalHours || 4), 0);
      intervalSliderEl.value = idx;
      intervalValueTextEl.textContent = formatInterval(INTERVAL_STEPS[idx]);
    }

    // --- Şimdi kontrol et ---
    const checkNowBtnEl = document.getElementById("checkNowBtn");
    checkNowBtnEl.addEventListener("click", async () => {
      checkNowBtnEl.disabled = true;
      const originalText = checkNowBtnEl.textContent;
      checkNowBtnEl.textContent = t(currentLang, "checking");
      try {
        await chrome.runtime.sendMessage({ type: "CHECK_SUBSCRIPTIONS_NOW" });
        await renderSubscriptions();
        await updateNextCheckText();
      } catch (error) {
        log.error(error);
      } finally {
        checkNowBtnEl.disabled = false;
        checkNowBtnEl.textContent = originalText;
      }
    });

    // --- Test bildirimi gönder (gerçek veriyle, hemen) ---
    const testNotifBtnEl = document.getElementById("testNotifBtn");
    const testNotifStatusEl = document.getElementById("testNotifStatus");

    testNotifBtnEl.addEventListener("click", async () => {
      testNotifBtnEl.disabled = true;
      testNotifStatusEl.textContent = t(currentLang, "sendingTestNotif");
      try {
        const response = await chrome.runtime.sendMessage({ type: "SEND_TEST_NOTIFICATION" });
        if (response?.ok) {
          testNotifStatusEl.textContent = `✓ ${t(currentLang, "testNotifSent")}`;
        } else {
          testNotifStatusEl.textContent = `⚠️ ${response?.error || t(currentLang, "testNotifFailed")}`;
        }
      } catch (error) {
        log.error(error);
        testNotifStatusEl.textContent = `⚠️ ${t(currentLang, "testNotifFailed")}`;
      } finally {
        testNotifBtnEl.disabled = false;
        setTimeout(() => (testNotifStatusEl.textContent = ""), 5000);
      }
    });

    // --- Bir sonraki otomatik kontrole ne kadar kaldığını gösteren sayaç ---
    const nextCheckTextEl = document.getElementById("nextCheckText");

    function formatCountdown(ms) {
      if (ms <= 0) return t(currentLang, "checkingSoon");
      const totalMin = Math.ceil(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h > 0) return `${h} ${t(currentLang, "hourShort")} ${m} ${t(currentLang, "minShort")}`;
      return `${m} ${t(currentLang, "minShort")}`;
    }

    async function updateNextCheckText() {
      try {
        const alarm = await chrome.alarms.get("checkSubscriptions");
        if (!alarm) {
          nextCheckTextEl.textContent = "";
          return;
        }
        // v1.50.1: Açılışta planlanan telafi kontrolü daha erkense onu göster.
        const catchup = await chrome.alarms.get("startupCatchup");
        const nextAt = Math.min(alarm.scheduledTime, catchup?.scheduledTime ?? Infinity);
        const remaining = nextAt - Date.now();
        let text = `${t(currentLang, "nextCheckIn")}: ${formatCountdown(remaining)}`;
        const fav = await chrome.alarms.get("checkFavorites");
        if (fav && (await getSubscriptions()).some((s) => s.favorite && s.enabled)) {
          text += ` · ★ ${formatCountdown(fav.scheduledTime - Date.now())}`;
        }
        nextCheckTextEl.textContent = text;
      } catch (error) {
        nextCheckTextEl.textContent = "";
      }
    }

    updateNextCheckText();
    setInterval(updateNextCheckText, 30000); // panel açık kaldığı sürece 30 saniyede bir güncelle

    renderSubscriptions();
    loadIntervalSlider();
