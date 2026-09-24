# Dates and currency labels

[Documentation](../README.md) / Features

UI date and currency labels use `src/core/format/time.ts`. Storage, feed URLs,
raw METAR/TAF text, exports, and HTML `dateTime` values retain their original formats.

| Context | Display |
| --- | --- |
| Source / edition date | `Sep 18` |
| Date in another year | `Sep 18, 2025` |
| Effective interval | `Sep 3–Oct 29` |
| Interval across years | `Dec 31, 2026–Jan 28, 2027` |
| UTC timestamp | `Sep 18 · 14:32Z` |
| Device-local timestamp | `Sep 18 · 07:32 PDT` |
| Paired Zulu / local timestamp | `Sep 18 · 14:32Z / 07:32 PDT` |
| Same-day time interval | `Sep 18 · 14:00–20:00Z` |
| Source age | `<1m old`, `15m old`, `1h 30m old`, `30d old` |
| Last successful check | `Checked now`, `Checked 5m ago` |
| Missing / invalid date or timestamp | `—` |
| Missing source age | `Age unknown` |

Month names are abbreviated English; numeric dates such as `09/10` are avoided.
Omit the current year, include other years, and include both years in calendar
intervals crossing a year boundary. UTC defines source calendar dates. Times use
a 24-hour clock, with `Z` for UTC and an explicit zone for device-local times.
Local annotations account for daylight-saving time at the displayed instant.
Paired timestamps share the date only when both clocks fall on the same calendar
day; otherwise each clock keeps its own date, including any required year.

Age uses completed elapsed units and never rounds up. Below one day, retain hours
and nonzero minutes; from one day onward use whole days. Seconds remain appropriate
for live instrument diagnostics; recording durations use `m:ss`.

Keep source date, observation/issue time, effective interval, and successful check
time distinct. A fresh download does not make an old observation new. Missing or
future timestamps must not appear as fresh data. Date formatting does not determine
whether a chart is effective or weather is current; product rules still own that.

The implemented [obstruction layer](../../src/layers/obstructions/README.md) shows `Source Sep 18`
in Layers, using the manifest's FAA `source.lastModified` timestamp. It currently
shows the source date without an elapsed-age label. Offline snapshots retain that
date; formatting does not impose a monthly expiration or replace source-specific
currency rules. Valid HTTP-date source timestamps are converted to epoch milliseconds
before formatting, so both those and ISO timestamps produce the same UTC date label.
