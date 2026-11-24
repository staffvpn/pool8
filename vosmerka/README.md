# Восьмёрка — сервер и игра на Cloudflare

Один Worker отдаёт игру (папка `public`) и держит онлайн:
- **D1** — профили, друзья, история партий;
- **Durable Objects** — кто в сети, приглашения, партии в реальном времени.

Нужен компьютер с Node.js 18 или новее (nodejs.org).

## Деплой

База `vosmerka-db` уже создана, таблицы в ней есть, её id и имя бота @Pool8game_bot уже вписаны в `wrangler.jsonc`.

Открой терминал в этой папке.

1. Установи зависимости:
```
npm install
```

2. Вход по API-токену (вместо `wrangler login`).
Токен: профиль в Cloudflare → My Profile → API Tokens → Create Token → шаблон «Edit Cloudflare Workers» → + Add more: Account / D1 / Edit → Create Token.
Account ID: Workers & Pages, правая колонка.

Windows (PowerShell):
```
$env:CLOUDFLARE_API_TOKEN="токен"
$env:CLOUDFLARE_ACCOUNT_ID="account_id"
```
Mac / Linux:
```
export CLOUDFLARE_API_TOKEN="токен"
export CLOUDFLARE_ACCOUNT_ID="account_id"
```
Проверка: `npx wrangler whoami` должен показать твой аккаунт.

3. Токен бота (лучше новый, через /revoke в @BotFather):
```
npx wrangler secret put BOT_TOKEN
```

4. Выкладка:
```
npx wrangler deploy
```
В конце будет адрес вида `https://vosmerka.ИМЯ.workers.dev`.

## Подключить к боту

@BotFather → /newapp → выбери @Pool8game_bot → название, описание, обложка `cover.png` → GIF /empty → адрес из `wrangler deploy` → короткое имя `play` (обязательно именно его, оно вписано в `wrangler.jsonc` как `APP_NAME`).

Если мини-апп уже создан с другим адресом: @BotFather → /myapps → выбери приложение → Edit Web App URL.

Игра откроется по ссылке `https://t.me/Pool8game_bot/play`.

## Обновить игру

Положи новый `public/index.html` и выполни `npx wrangler deploy`.

## Как устроен онлайн

- Вход по данным Телеграма (initData проверяется подписью токена бота), регистрации нет.
- Друзья: ссылка `t.me/бот/play?startapp=f<id>`. Кто откроет игру по ней — становится другом с обеих сторон.
- Приглашение: если друг в игре — всплывает окно; если нет — бот пишет ему сообщение с кнопкой «Принять».
- Удар считает телефон того, кто бьёт; сервер проверяет итог на здравый смысл и применяет правила.
  На платном тарифе Workers можно поставить `SERVER_PHYSICS` = `"1"`: тогда физику каждого удара пересчитывает сервер, и подделать удар нельзя.
  На бесплатном тарифе лимит процессорного времени на запрос маленький, поэтому по умолчанию `"0"`.
- На ход 60 секунд, по истечении — фол и шар в руке у соперника.
