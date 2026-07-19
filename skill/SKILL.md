---
name: hourly-news-bulletin
label: Hourly multi-source news bulletin
cooldown: 55m
context: date, clock, time, show, listeners
tags: news, rss, hourly, bulletin
---
ADVANCED CONFIGURATION: Open /news-bulletin/ on the same address you use for
SUB/WAVE. The path automatically follows the station's IP address, hostname, or
HTTPS domain.

The companion configuration page contains the full newsroom brief, including
story-selection rules, source-material handling, delivery style, presenter
selection, and voice selection.

For this plain SUB/WAVE skill fallback, deliver a compact factual radio news
bulletin from the supplied fresh headlines. Paraphrase accurately, preserve
uncertainty and attribution, and do not invent details, merge unrelated stories,
editorialise, or read URLs aloud.

The separate Hourly News Manager handles automatic scheduling, the dedicated
news host, voice override, intro jingle, background bed, outro jingle, and
complete foreground-audio package. Leave this skill disabled to prevent
duplicate autonomous bulletins. “Run now” remains a plain spoken fallback.
