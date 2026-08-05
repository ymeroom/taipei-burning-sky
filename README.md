# 台北火燒雲預報 🌇

每日台北時間 **15:00**（今晚日落）與 **23:30**（明早日出）自動更新，
預測台北市日出／日落出現火燒雲的機率。

**網站：** https://ymeroom.github.io/taipei-burning-sky/

## 運作方式

GitHub Actions 依排程執行 `scripts/update.mjs`：

1. 抓取 [Open-Meteo](https://open-meteo.com/) 天氣預報（分層雲量、濕度、能見度、降雨機率、日出日落時刻）與空氣品質（氣溶膠光學厚度 AOD）
2. 以事件時刻做線性插值，五因子加權評分（滿分 100）：
   中高雲畫布 40・低雲阻擋 25・空氣通透度 15・氣溶膠 10・降雨干擾 10
3. 寫入 `docs/data.json`（最新預測）與 `docs/history.json`（歷史紀錄），commit 後 GitHub Pages 自動重新發佈

等級：0–24 別期待｜25–49 普通｜50–74 值得一看｜75–100 大燒預警

## 本機開發

```bash
node --test                 # 單元測試
node scripts/update.mjs     # 手動抓一次資料
npx http-server docs        # 本機預覽
```

僅供參考——天空從不照劇本走。
