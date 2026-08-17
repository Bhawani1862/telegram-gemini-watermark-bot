# Telegram Gemini Watermark Processing Bot

यह Node.js/ESM Telegram bot photo और video प्राप्त करके स्थानीय रूप से process करता है और परिणाम उसी chat में वापस भेजता है। Image processing के लिए `@pilio/gemini-watermark-remover/node` का ImageData pipeline तथा video के लिए उसका browser-based video SDK उपयोग किया गया है। यह package Gemini के ज्ञात visible watermark format के लिए बनाया गया है; arbitrary logo या किसी अन्य watermark पर परिणाम की गारंटी नहीं है। [1]

> **कानूनी और नैतिक उपयोग:** केवल अपनी या स्पष्ट अनुमति वाली सामग्री पर उपयोग करें। किसी creator की attribution, ownership, copyright notice या सुरक्षा-संबंधी watermark हटाने के लिए इस bot का उपयोग न करें।

## विशेषताएँ

| सुविधा | विवरण |
|---|---|
| Photo input | Telegram photo को decode करके ImageData SDK से process करता है और PNG/JPEG output भेजता है। |
| Video input | Telegram video/document को Chromium के माध्यम से SDK video pipeline में process करता है। |
| Queue | Single worker queue memory pressure कम रखती है; बाद के jobs FIFO क्रम में चलते हैं। |
| Rate limiting | प्रत्येक user के लिए configurable rolling-window limit लागू है। |
| File validation | Telegram download के दौरान streaming byte limit लागू होती है; output पर भी सीमा जाँची जाती है। |
| Cleanup | हर job के बाद per-job temporary directory हटाई जाती है। |
| Reliability | Docker restart policy, signal handling, structured logs और friendly Hindi errors शामिल हैं। |

## आवश्यकताएँ

AWS Ubuntu server पर कम से कम 8 GB RAM और 30 GB free storage उपयुक्त है, लेकिन video processing के समय disk usage और concurrent workload पर नज़र रखें। Server पर SSH access और sudo अधिकार चाहिए। Docker image Chromium, Playwright, FFmpeg और native image dependencies के साथ बनती है। Bot long polling उपयोग करता है, इसलिए webhook के लिए अलग public HTTP port या domain आवश्यक नहीं है।

Telegram Bot API में `getFile` download सीमा सामान्यतः 20 MB होती है; इसी कारण default `MAX_INPUT_MB=20` रखा गया है। [2] Output के लिए Telegram की upload limits और आपके server की memory को ध्यान में रखते हुए सीमा configurable है।

## 1. BotFather से Telegram token बनाना

Telegram में [@BotFather](https://t.me/BotFather) खोलें और `/newbot` भेजें। Bot का display name और unique username दें; username का अंत `bot` से होना चाहिए। BotFather आपको एक secret token देगा। इस token को किसी chat, Git repository या screenshot में साझा न करें।

आप `/setdescription`, `/setabouttext` और `/setcommands` से bot का profile और command menu भी सेट कर सकते हैं। Suggested commands हैं:

```text
start - Bot शुरू करें और usage देखें
help - Help और limits देखें
```

## 2. Files server पर upload करें

अपने local computer से यह folder server पर भेजें:

```bash
scp -r telegram-gemini-watermark-bot ubuntu@YOUR_SERVER_IP:/home/ubuntu/
ssh ubuntu@YOUR_SERVER_IP
cd /home/ubuntu/telegram-gemini-watermark-bot
```

यदि आपने files किसी दूसरे directory में upload की हैं, तो उसी directory में `cd` करें।

## 3. `.env` भरें और deploy करें

पहले template copy करें:

```bash
cp .env.example .env
nano .env
```

कम से कम यह value बदलें:

```env
BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

फिर script चलाएँ:

```bash
chmod +x deploy.sh
./deploy.sh
```

पहली बार script Docker install करेगी, UFW में SSH allow करेगी, image build करेगी और container को `restart: unless-stopped` के साथ शुरू करेगी। यह setup inbound application port नहीं खोलता, क्योंकि bot Telegram long polling से updates प्राप्त करता है। SSH allow किए बिना firewall enable न करें।

Deployment के बाद status देखें:

```bash
docker compose ps
docker compose logs -f --tail=200
```

यदि आप root user से नहीं चलाते हैं, तो Docker commands के आगे `sudo` लगाएँ या user को docker group में जोड़ें:

```bash
sudo usermod -aG docker "$USER"
# फिर logout/login करें
```

## 4. Bot का उपयोग

Bot chat में `/start` या `/help` भेजें। इसके बाद photo सीधे भेजें अथवा video को Telegram video के रूप में भेजें। यदि video किसी document की तरह भेजा गया है और उसका MIME type `video/*` है, तो bot उसे भी स्वीकार करेगा। Bot पहले “queue” status, फिर download और processing status दिखाएगा। Processing पूरी होने पर cleaned output उसी chat में भेजा जाएगा।

एक समय में केवल एक job process होती है ताकि 8 GB RAM server पर Chromium और large media के कारण memory exhaustion कम हो। अन्य users के jobs queue में प्रतीक्षा करेंगे। Default queue 20 jobs की है; queue full होने पर bot नया job स्वीकार नहीं करेगा।

## Environment variables

| Variable | Default | अर्थ |
|---|---:|---|
| `BOT_TOKEN` | आवश्यक | BotFather token। |
| `MAX_INPUT_MB` | `20` | Downloaded input की अधिकतम size। |
| `MAX_OUTPUT_MB` | `49` | Output भेजने से पहले maximum size। |
| `RATE_LIMIT_WINDOW_SECONDS` | `3600` | Rate-limit window। |
| `RATE_LIMIT_MAX` | `5` | प्रति user window में jobs। |
| `MAX_QUEUE_SIZE` | `20` | Waiting jobs की अधिकतम संख्या। |
| `TEMP_DIR` | `/app/tmp` | Temporary files का path। |
| `VIDEO_TIMEOUT_MS` | `600000` | Video processing inactivity timeout। |
| `VIDEO_BITRATE` | `12000000` | Video export bitrate, bits per second। |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` या `silent`। |

`MAX_INPUT_MB` को 20 से ऊपर बढ़ाने पर Telegram Bot API की download सीमा के कारण bot फिर भी fail हो सकता है। बड़े media workflow के लिए अलग storage/download architecture चाहिए; केवल environment value बढ़ाना पर्याप्त नहीं है।

## संचालन और maintenance

नया code deploy करने के लिए files update करके यह चलाएँ:

```bash
docker compose up -d --build
```

Logs:

```bash
docker compose logs -f --tail=200
```

Restart:

```bash
docker compose restart
```

Stop:

```bash
docker compose down
```

यदि image cache बहुत बड़ा हो जाए, तो सावधानी से unused images हटाएँ:

```bash
docker image prune
```

Server disk पर Docker usage जाँचें:

```bash
docker system df
df -h
```

## Troubleshooting

### Bot start नहीं हो रहा

`docker compose logs --tail=200` देखें। यदि `BOT_TOKEN is required` या token error आए, `.env` में वास्तविक BotFather token भरें और सुनिश्चित करें कि file का नाम `.env` ही है। Token को quotes में रखने की आवश्यकता नहीं है।

### `getFile` या download failed

Input file 20 MB से छोटी रखें। Telegram की file download limit, bot permissions और server की outbound HTTPS connectivity जाँचें:

```bash
curl -I https://api.telegram.org
```

यदि server proxy या restrictive egress firewall के पीछे है, तो Telegram API तक HTTPS outbound access allow करें।

### Video processing timeout या browser crash

Video processing CPU/RAM intensive है। एक समय में एक job की design जानबूझकर रखी गई है। छोटे या कम-resolution video से शुरू करें। `VIDEO_TIMEOUT_MS` बढ़ाएँ, उदाहरण:

```env
VIDEO_TIMEOUT_MS=1200000
```

फिर rebuild करें:

```bash
docker compose up -d --build
```

Chromium dependency समस्या पर image को फिर से build करें:

```bash
docker compose build --no-cache
docker compose up -d
```

### `No space left on device`

`df -h` और `docker system df` देखें। Container हर completed job का temp directory हटाता है, लेकिन crashed jobs या Docker build layers disk भर सकते हैं। पुराने unused images हटाएँ और लंबे समय के लिए log rotation configure करें।

### Output Telegram पर नहीं भेजा जा रहा

`MAX_OUTPUT_MB` कम करके छोटी output सीमा रखें और logs में वास्तविक Telegram error देखें। Photo बहुत बड़ी होने पर bot document fallback लागू करने के बजाय आपको image quality/format या limit adjust करनी पड़ सकती है। Video के लिए Telegram-compatible MP4 output आवश्यक है।

### Watermark detect नहीं हुआ

यह package ज्ञात Gemini visible watermark patterns के लिए है। [Official package documentation](https://www.npmjs.com/package/@pilio/gemini-watermark-remover) के अनुसार unusual format, corrupted file या अलग watermark implementation पर result unchanged या imperfect हो सकता है। Original file सुरक्षित रखें और output को publish करने से पहले manually verify करें।

## Security checklist

`.env` को `chmod 600` रखें और उसे Git में commit न करें। Production server पर SSH keys उपयोग करें, password login disable करने पर पहले alternate access verify करें, और नियमित security updates लगाएँ:

```bash
sudo apt update && sudo apt upgrade -y
```

Bot को public group में जोड़ने से पहले rate limit, queue और allowed content policy जाँचें। यह implementation files को permanent storage में नहीं रखती; temporary job files processing के बाद हटाए जाते हैं। फिर भी logs में secrets या raw media content लिखे नहीं जाते।

## References

[1]: https://www.npmjs.com/package/@pilio/gemini-watermark-remover "@pilio/gemini-watermark-remover package documentation"

[2]: https://core.telegram.org/bots/api#getfile "Telegram Bot API: getFile"
