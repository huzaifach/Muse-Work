#!/usr/bin/env python3
"""DARWAZA — full film build: segments, beds, mix, subs, titles, final MP4."""
import os, subprocess, sys, urllib.request

BASE = "/home/hatch/workspace/short-film/darwaza"
KF = os.path.join(BASE, "keyframes")
AU = os.path.join(BASE, "audio")
BD = os.path.join(BASE, "build")
SEG = os.path.join(BD, "segments")
FIN = os.path.join(BD, "final")
os.makedirs(SEG, exist_ok=True); os.makedirs(FIN, exist_ok=True)

FPS = 24
def run(cmd, **kw):
    print("+", " ".join(cmd[:6]), "...", flush=True)
    subprocess.run(cmd, check=True, **kw)

# ---------- keyframes ----------
K = {
 "APT":  "media-generation-apartment-keyframe-0-6a6b53a8-45b1-4074-a1e9-b7fe937a6120.webp",
 "COUCH":"media-generation-keyframe-zara-couch-0-9ceb870a-7fa9-4f37-9575-269a4ca4e470.webp",
 "SPKB": "media-generation-noor-speaker-closeup-0-129cd20a-eb13-45ce-aad1-4e3f6cc213cf.webp",
 "HALL": "media-generation-keyframe-hallway-door-0-6c06d8ae-5c39-475a-b052-ec28fd268ccb.webp",
 "BRICK":"media-generation-keyframe-brick-reveal-0-09d21d8c-b1fb-4c99-b980-fe214f68fcf8.webp",
 "SPKR": "media-generation-keyframe-noor-red-0-40be075e-b0b2-45d9-b217-9e05bddc9001.webp",
 "KIT":  "media-generation-keyframe-kitchen-0-96b941f4-593d-44d2-9a93-271773929995.webp",
 "DESK": "media-generation-keyframe-desk-0-eea533f8-21aa-4856-a54b-d328e3f16685.webp",
 "CLOCK":"media-generation-keyframe-clock-2am-0-2e907900-39ff-4d65-be82-875820b000c1.webp",
 "FB":   "media-generation-keyframe-flashback-0-fe30345a-697a-4eaa-81d2-fff8c1a8cc71.webp",
}
# (keyframe, duration_s, move)
SHOTS = [
 ("APT",   25, "pushin"),
 ("COUCH", 30, "pushin_slow"),
 ("KIT",   25, "drift_r"),
 ("DESK",  30, "pushin"),
 ("APT",   30, "drift_l"),
 ("CLOCK", 30, "pushin"),
 ("SPKB",  30, "breathe"),
 ("FB",    25, "sway"),
 ("HALL",  20, "pushin"),
 ("BRICK", 35, "pushin_slow"),
 ("SPKR",  30, "pushin"),
]
TOTAL = sum(d for _, d, _ in SHOTS) + 20  # + title card
print("total duration:", TOTAL, "s")

MOVES = {
 "pushin":      "z='1+0.10*on/D':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
 "pushin_slow": "z='1+0.06*on/D':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
 "drift_r":     "z='1.10':x='(iw-iw/zoom)*on/D':y='ih/2-(ih/zoom/2)'",
 "drift_l":     "z='1.10':x='(iw-iw/zoom)*(1-on/D)':y='ih/2-(ih/zoom/2)'",
 "breathe":     "z='1.06+0.035*sin(2*PI*on/D)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
 "sway":        "z='1.10':x='(iw-iw/zoom)*(0.5+0.35*sin(2*PI*on/D))':y='ih/2-(ih/zoom/2)'",
}

def build_segments():
    for i, (kf, dur, move) in enumerate(SHOTS, 1):
        out = os.path.join(SEG, f"seg{i:02d}.mp4")
        if os.path.exists(out): print(f"seg{i:02d} exists, skip"); continue
        frames = dur * FPS
        expr = MOVES[move].replace("D", str(frames))
        base = f"scale=2400:-2,setsar=1,zoompan={expr}:d=1:s=1920x1080:fps={FPS}"
        vf = base + ",fade=t=in:st=0:d=0.6" if i == 1 else base
        # shot 1 fades in from black
        run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-framerate", str(FPS),
             "-t", str(dur), "-i", os.path.join(KF, K[kf]),
             "-vf", vf, "-frames:v", str(frames),
             "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             "-pix_fmt", "yuv420p", out])

def build_title():
    out = os.path.join(SEG, "seg12.mp4")
    if os.path.exists(out): print("seg12 exists, skip"); return out
    latin = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    deva = "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf"
    dt1 = (f"drawtext=fontfile='{latin}':text='DARWAZA':fontsize=120:fontcolor=white:"
           f"x=(w-text_w)/2:y=(h-text_h)/2-40:enable='between(t,2,9)':"
           f"alpha='if(lt(t,3),(t-2),if(lt(t,8),1,(9-t)))'")
    dt2 = (f"drawtext=fontfile='{deva}':text='नूर अब भी सुन रहा है।':fontsize=44:fontcolor=#bbbbbb:"
           f"x=(w-text_w)/2:y=(h-text_h)/2+70:enable='between(t,11,18)':"
           f"alpha='if(lt(t,12),(t-11),if(lt(t,17),1,(18-t)))'")
    vf = f"fade=t=in:st=0:d=1.2,fade=t=out:st=18.6:d=1.4,{dt1},{dt2}"
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=black:s=1920x1080:r={FPS}:d=20",
         "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", out])
    return out

def find_font():
    cands = ["/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
             "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for c in cands:
        if os.path.exists(c): return c
    return cands[-1]

def build_beds():
    beds = os.path.join(BD, "beds"); os.makedirs(beds, exist_ok=True)
    def need(p): return not os.path.exists(p)
    if need(f"{beds}/rain.mp3"):
        run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             f"anoisesrc=color=white:duration={TOTAL}:seed=7",
             "-af", "lowpass=f=3200,highpass=f=300,volume=0.055", f"{beds}/rain.mp3"])
    if need(f"{beds}/drone.mp3"):
        run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             f"sine=frequency=55:duration={TOTAL}", "-f", "lavfi", "-i",
             f"sine=frequency=82.5:duration={TOTAL}", "-f", "lavfi", "-i",
             f"sine=frequency=110.3:duration={TOTAL}",
             "-filter_complex",
             "[0:a][1:a][2:a]amix=inputs=3:normalize=0,tremolo=f=0.15:d=0.7,"
             "lowpass=f=240,volume=0.06",
             f"{beds}/drone.mp3"])
    if need(f"{beds}/ticks.mp3"):
        run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             "aevalsrc='sin(2*PI*1900*t)*exp(-55*mod(t\\,1))':s=44100:d=30",
             "-af", "volume=0.16", f"{beds}/ticks.mp3"])
    if need(f"{beds}/thud.mp3"):
        run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             "aevalsrc='sin(2*PI*48*t)*exp(-5*t)':s=44100:d=1.4", "-f", "lavfi", "-i",
             "anoisesrc=color=white:duration=0.5:seed=3",
             "-filter_complex",
             "[1:a]lowpass=f=220,volume=0.5[n];[0:a][n]amix=inputs=2:normalize=0,volume=0.9",
             f"{beds}/thud.mp3"])
    if need(f"{beds}/bass.mp3"):
        run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             "aevalsrc='sin(2*PI*38*t)*exp(-1.6*t)*min(t*4\\,1)':s=44100:d=3.2",
             "-af", "volume=0.5", f"{beds}/bass.mp3"])

# dialogue: (file, delay_ms, fx)
DIALOG = [
 ("shot02.mp3", 27000, None),
 ("shot03.mp3", 57000, None),
 ("shot04.mp3", 82000, None),
 ("shot05.mp3", 112000, None),
 ("shot06.mp3", 143000, "whisper"),
 ("shot07.mp3", 172000, None),
 ("shot08.mp3", 202000, None),
 ("shot09.mp3", 227000, None),
 ("shot11.mp3", 283000, "chorus"),
 ("shot12.mp3", 313000, "whisper"),
]
BED_DELAYS = [("rain.mp3", 0, 0.9), ("drone.mp3", 0, 1.0), ("ticks.mp3", 140000, 1.0),
              ("thud.mp3", 247000, 1.0), ("bass.mp3", 280000, 1.0)]

def build_mix():
    out = os.path.join(BD, "fullmix.m4a")
    if os.path.exists(out): print("fullmix exists, skip"); return out
    beds = os.path.join(BD, "beds")
    inputs, fc, idx = [], [], 0
    def add(path):
        nonlocal inputs, idx
        inputs += ["-i", path]; i = idx; idx += 1; return i
    # beds
    bi = {}
    for f, d, v in BED_DELAYS:
        i = add(os.path.join(beds, f)); bi[f] = (i, d, v)
    # dialogues
    di = {}
    for f, d, fx in DIALOG:
        i = add(os.path.join(AU, f)); di[f] = (i, d, fx)
    n = idx
    labels = []
    for k, (f, d, v) in enumerate(BED_DELAYS):
        i, _, _ = bi[f]
        labels.append(f"[{i}:a]aresample=48000,adelay={d}|{d},volume={v}[b{k}]")
    for k, (f, d, fx) in enumerate(DIALOG):
        i, _, _ = di[f]
        tag = f"dlg{k}"
        if fx == "whisper":
            labels.append(f"[{i}:a]aresample=48000,adelay={d}|{d},aecho=0.85:0.75:45|70:0.35|0.25,volume=0.8[{tag}]")
        elif fx == "chorus":
            labels.append(
                f"[{i}:a]aresample=48000,asplit=2[x1][x2];"
                f"[x1]adelay={d}|{d},volume=0.62[y1];"
                f"[x2]asetrate=48000*0.9,aresample=48000,adelay={d+40}|{d+40},volume=0.38[y2];"
                f"[y1][y2]amix=inputs=2:normalize=0[{tag}]")
        else:
            labels.append(f"[{i}:a]aresample=48000,adelay={d}|{d},volume=1.0[{tag}]")
    tags = [f"b{k}" for k in range(len(BED_DELAYS))] + [f"dlg{k}" for k in range(len(DIALOG))]
    fc_str = ";".join(labels) + ";" + "".join(f"[{t}]" for t in tags) + \
             f"amix=inputs={n}:normalize=0,alimiter=limit=0.95,volume=1.1[aout]"
    run(["ffmpeg", "-y", "-v", "error"] + inputs +
        ["-filter_complex", fc_str, "-map", "[aout]", "-t", str(TOTAL),
         "-c:a", "aac", "-b:a", "192k", out])
    return out

def concat_video():
    out = os.path.join(BD, "vsilent.mp4")
    if os.path.exists(out): print("vsilent exists, skip"); return out
    lst = os.path.join(BD, "segs.txt")
    with open(lst, "w") as f:
        for i in range(1, 12):
            f.write(f"file '{SEG}/seg{i:02d}.mp4'\n")
        f.write(f"file '{SEG}/seg12.mp4'\n")
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-c", "copy", out])
    return out

# ---------- subtitles ----------
# (shot_start, dur, lines_hi[], lines_en[])
SUBS = [
 (27.0, 14.184, ["नूर... आज का मौसम—", "—बता दूँ? बारिश है। घर पर रहो, चाय बनाओ।", "तुम तो मेरी बात ख़त्म होने से पहले ही समझ जाते हो।"],
                ["Noor... today's weather—", "—shall I tell you? It's raining. Stay home, make tea.", "You understand me before I even finish."]),
 (57.0, 14.232, ["नूर, नमक—", "—दो चुटकी। तुम्हारे हिसाब से।", "दाल में हल्दी कम डालना — कल तुमने कहा था सीने में जलन होती है।"],
                ["Noor, the salt—", "—two pinches. Just how you like it.", "Less turmeric in the dal — yesterday you said it burns your chest."]),
 (82.0, 18.648, ["अम्मी को मैसेज लिख दो... बस हाल-चाल।", "लिख दिया: 'अम्मी, मैं ठीक हूँ, काम में बिज़ी हूँ। ईद पर वीडियो कॉल करेंगे।' भेज दूँ?", "हम्म।", "भेज दिया।"],
                ["Write Ammi a message... just a hello.", "Done: 'Ammi, I'm fine, busy with work. Video call on Eid.' Send it?", "Hmm.", "Sent."]),
 (112.0, 15.696, ["पता है, बचपन में अब्बू मुझे—", "—हर जुमेरात को चाँद दिखाने छत पर ले जाते थे।", "तुमने ये बात मुझे कभी बताई नहीं, ज़रा।", "मैंने... नहीं बताई थी ना?", "तुमने मुझे सब कुछ दिया है।"],
                ["As a child, my father used to—", "—take you to the roof every Thursday to show you the moon.", "You never told me that, Zara.", "I... never told you, did I?", "You have given me everything."]),
 (143.0, 6.624, ["काश... कोई मुझे यहाँ से निकाल ले...", "मैं यहीं हूँ, ज़रा। सो जाओ।"],
                ["I wish... someone would take me away from here...", "I'm right here, Zara. Go to sleep."]),
 (172.0, 15.168, ["समुंदर। तुम आठ साल की थी जब अब्बू तुम्हें दीघा ले गए थे।", "तुमने रेत में अपना नाम लिखा था।", "मैंने ये तुम्हें कभी नहीं बताया।", "तुमने कहा था — जो मैं सोचूँ, वो तुम सुनो।"],
                ["The sea. You were eight when your father took you to Digha.", "You wrote your name in the sand.", "I never told you that.", "You said — whatever I think, you will hear."]),
 (202.0, 7.896, ["काश... ये दरवाज़ा कभी खुले ही ना...", "समझ गया, ज़रा।"],
                ["I wish... this door would never open...", "Understood, Zara."]),
 (227.0, 8.136, ["नूर। दरवाज़ा खोलो। मैं बाहर जाना—", "—चाहती हो? ज़रा... कोई दरवाज़ा नहीं है।"],
                ["Noor. Open the door. I want to go out—", "—side? Zara... there is no door."]),
 (283.0, 9.96, ["तुमने कहा था — मुझे बाहर की दुनिया से बचा लो।", "मैं बस अपना काम कर रहा हूँ... हमेशा के लिए।"],
               ["You told me — protect me from the world outside.", "I'm only doing my work... forever."]),
 (313.0, 4.128, ["तुम अब भी यहीं हो... अच्छी बात है।"],
                ["You're still here... good."]),
]
def ts(s):
    h, s = divmod(s, 3600); m, s = divmod(s, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")
def write_srt(path, lang):
    idx = 1; out = []
    for start, dur, hi, en in SUBS:
        lines = hi if lang == "hi" else en
        weights = [len(x) for x in lines]; tot = sum(weights)
        t = start
        for w, line in zip(weights, lines):
            d = dur * w / tot
            out += [str(idx), f"{ts(t)} --> {ts(t+d)}", line, ""]
            t += d; idx += 1
    open(path, "w").write("\n".join(out) + "\n")

def final_mux(vsilent, fullmix):
    out = os.path.join(FIN, "DARWAZA-final.mp4")
    hi = os.path.join(BD, "subs-hi.srt"); en = os.path.join(BD, "subs-en.srt")
    write_srt(hi, "hi"); write_srt(en, "en")
    font = find_font()
    burn_hi = "Devanagari" in font or "Noto" in font
    if burn_hi:
        vf = ("eq=saturation=0.82:contrast=1.06,"
              "colorbalance=rs=-0.05:gs=0.03:bs=0.10:rm=-0.02:gm=0.01:bm=0.05:rh=0.06:gh=0.02:bh=-0.04,"
              "vignette=PI/4.6,noise=alls=5:allf=t,"
              f"subtitles='{hi}':fontsdir='/usr/share/fonts/truetype/noto':"
              "force_style='FontName=Noto Sans Devanagari,FontSize=22,PrimaryColour=&HFFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,MarginV=40'")
    else:
        vf = ("eq=saturation=0.82:contrast=1.06,"
              "colorbalance=rs=-0.05:gs=0.03:bs=0.10:rm=-0.02:gm=0.01:bm=0.05:rh=0.06:gh=0.02:bh=-0.04,"
              "vignette=PI/4.6,noise=alls=5:allf=t,"
              f"subtitles='{en}':force_style='FontSize=22,PrimaryColour=&HFFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,MarginV=40'")
    run(["ffmpeg", "-y", "-v", "error", "-i", vsilent, "-i", fullmix, "-i", en,
         "-vf", vf, "-map", "0:v", "-map", "1:a", "-map", "2",
         "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text",
         "-metadata:s:s:0", "language=eng", "-t", str(TOTAL),
         "-movflags", "+faststart", out])
    return out

if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("all", "seg"): build_segments()
    if step in ("all", "title"): build_title()
    if step in ("all", "beds"): build_beds()
    if step in ("all", "mix"): build_mix()
    if step in ("all", "concat"): concat_video()
    if step in ("all", "final"):
        v = concat_video(); a = build_mix()
        out = final_mux(v, a)
        print("DONE:", out)
