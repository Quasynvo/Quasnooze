"""Rebuild Fluid Motion brand assets. Developer-only: Python 3 + Pillow.

The GIF is a silent, deterministic state walkthrough, not recorded audio or AI.
The live source of truth is public/visualizer.js; the same ribbon equations and
palette are used here so README art matches the component's visual signature.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import base64, math, shutil

ROOT = Path(__file__).resolve().parents[1]
CYAN, VIOLET, MAGENTA, AMBER, CRIMSON = (110,231,249), (167,139,250), (240,171,252), (255,191,105), (251,113,133)
PALETTES = {'idle': (CYAN,VIOLET), 'listening': (CYAN,MAGENTA), 'thinking': (VIOLET,AMBER), 'speaking': ((157,248,255),MAGENTA), 'error': (CRIMSON,AMBER)}
STATES = list(PALETTES)
TAU = math.tau


def rgba(c, a): return (*c, round(a * 255))
def blend(a,b,t): return tuple(round(x+(y-x)*t) for x,y in zip(a,b))


def ribbon_points(cx, cy, radius, phase, ribbon, state, level=0):
    points=[]
    for i in range(145):
        angle=i/144*TAU
        harmonic=math.sin(angle*3+phase*.7+ribbon*1.8)*.035+math.cos(angle*5-phase*.45+ribbon)*.017
        energy=level*.09*math.sin(angle*2+phase) if state=='listening' else 0
        rr=radius*(.89+ribbon*.072+harmonic+energy)
        local_x=math.cos(angle)*rr
        local_y=math.sin(angle)*rr*(.88+ribbon*.035)
        turn=phase*(.4 if ribbon%2==0 else -.55)*.35+ribbon*.75
        points.append((cx+local_x*math.cos(turn)-local_y*math.sin(turn),cy+local_x*math.sin(turn)+local_y*math.cos(turn)))
    return points


def engine(size=440, state='idle', phase=2.4, level=.25):
    # Render linework at 2x, then downsample for clean README/native edges.
    scale=2; size*=scale
    im=Image.new('RGBA',(size,size)); d=ImageDraw.Draw(im)
    cx=cy=size/2; radius=size*.285; colors=PALETTES[state]
    aura=Image.new('RGBA',im.size); ad=ImageDraw.Draw(aura)
    for fraction,alpha in [(1.6,.018),(1.35,.025),(1.13,.04),(.94,.045)]:
        rr=radius*fraction; ad.ellipse((cx-rr,cy-rr,cx+rr,cy+rr),fill=rgba(colors[1],alpha))
    im.alpha_composite(aura.filter(ImageFilter.GaussianBlur(22*scale)))
    for fraction,alpha in [(.86,.16),(.8,.2),(.73,.25),(.65,.3)]:
        rr=radius*fraction;d.ellipse((cx-rr,cy-rr,cx+rr,cy+rr),fill=(16,28,47,round(alpha*255)))
    glow=Image.new('RGBA',im.size); gd=ImageDraw.Draw(glow)
    for ribbon in range(4 if state=='thinking' else 3):
        pts=ribbon_points(cx,cy,radius,phase,ribbon,state,level)
        gd.line(pts,fill=rgba(colors[ribbon%2],.32),width=7*scale,joint='curve')
    im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6*scale)))
    d=ImageDraw.Draw(im)
    for ribbon in range(4 if state=='thinking' else 3):
        pts=ribbon_points(cx,cy,radius,phase,ribbon,state,level)
        for a,b in zip(pts,pts[1:]):
            t=(math.atan2(b[1]-cy,b[0]-cx)/TAU+.5)%1
            d.line((a,b),fill=rgba(blend(colors[0],colors[1],t),.85),width=round(1.35*scale))
    if state=='thinking':
        for i in range(28):
            angle=i*2.399963+phase*.45;rr=radius*(1.12+(i%5)*.07)
            x=cx+math.cos(angle)*rr;y=cy+math.sin(angle)*rr*.78;sz=(.65+(i%3)*.35)*scale
            d.ellipse((x-sz,y-sz,x+sz,y+sz),fill=rgba(colors[i%2],.3+(i%4)*.15))
    if state=='speaking':
        for i in range(48):
            angle=i/48*TAU-math.pi/2;energy=(math.sin(i*.63+phase*6)*math.sin(i*.19-phase*3)+1)*.5
            length=radius*(.025+energy*.16)
            d.line((cx+math.cos(angle)*radius*.61,cy+math.sin(angle)*radius*.61,cx+math.cos(angle)*(radius*.61+length),cy+math.sin(angle)*(radius*.61+length)),fill=rgba(colors[i%2],.5+energy*.45),width=round(1.6*scale))
    for line in range(2):
        pts=[]
        for i in range(41):
            x=(i/40-.5)*radius*.62;y=math.sin(i/40*TAU+phase*1.3+line*math.pi)*radius*.065+(line-.5)*radius*.09
            pts.append((cx+x,cy+y))
        d.line(pts,fill=rgba(colors[line],.8),width=round(1.4*scale),joint='curve')
    return im.resize((size//scale,size//scale),Image.Resampling.LANCZOS)


def vector_mark():
    layers=[]
    for ribbon in range(3):
        pts=ribbon_points(256,256,145,2.4,ribbon,'idle',0)
        path='M'+' L'.join(f'{x:.2f},{y:.2f}' for x,y in pts)+' Z'
        layers.append(f'<path d="{path}" stroke="url(#spectrum)" stroke-opacity="{.85-ribbon*.12}" stroke-width="2.5"/>')
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc"><title id="title">Quasnooze Fluid Motion mark</title><desc id="desc">Three cyan and violet interference ribbons surrounding a dark glass core.</desc><defs><linearGradient id="spectrum" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#6ee7f9"/><stop offset=".55" stop-color="#a78bfa"/><stop offset="1" stop-color="#f0abfc"/></linearGradient><radialGradient id="core"><stop stop-color="#1c3048"/><stop offset="1" stop-color="#080d19"/></radialGradient><radialGradient id="aura"><stop stop-color="#a78bfa" stop-opacity=".18"/><stop offset="1" stop-color="#6ee7f9" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" rx="112" fill="#080d19"/><circle cx="256" cy="256" r="238" fill="url(#aura)"/><circle cx="256" cy="256" r="124" fill="url(#core)"/><g fill="none">'''+''.join(layers)+'''<path d="M210 250Q233 229 256 250T302 250M210 265Q233 286 256 265T302 265" stroke="url(#spectrum)" stroke-width="2" stroke-linecap="round"/></g></svg>'''


def build():
    for folder in ['public/brand','site/assets','docs/images','docs/brand']: (ROOT/folder).mkdir(parents=True,exist_ok=True)
    mark=vector_mark()
    for path in ['assets/voice-engine.svg','public/brand/voice-engine.svg','site/assets/voice-engine.svg','public/favicon.svg']:
        (ROOT/path).write_text(mark)
    for name in ['visualizer.js','visualizer.css','demo-signal.js']:
        shutil.copyfile(ROOT/'public'/name,ROOT/'site/assets'/name)
    still=engine(512)
    still.resize((160,160),Image.Resampling.LANCZOS).save(ROOT/'public/brand/voice-engine-native.png',optimize=True)
    still.resize((180,180),Image.Resampling.LANCZOS).convert('RGB').save(ROOT/'public/apple-touch-icon.png',optimize=True)
    # Preserve the organization's selected Q mark; it is not the assistant identity.
    logo=Image.open(ROOT/'assets/quasynvo-logo-source.png').convert('RGB');pix=logo.load();xs=[];ys=[]
    for y in range(0,logo.height,4):
        for x in range(0,logo.width,4):
            _,g,b=pix[x,y]
            if g>160 and b>160:xs.append(x);ys.append(y)
    x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys);side=max(x1-x0,y1-y0)*1.35;cx=(x0+x1)/2;cy=(y0+y1)/2
    logo=logo.crop((int(cx-side/2),int(cy-side/2),int(cx+side/2),int(cy+side/2))).resize((512,512))
    logo.save(ROOT/'assets/quasynvo-logo.png',optimize=True)
    b64=base64.b64encode((ROOT/'assets/quasynvo-logo.png').read_bytes()).decode()
    org_svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Quasynvo orbital Q logo"><image width="512" height="512" href="data:image/png;base64,{b64}"/></svg>'
    for path in ['assets/mark.svg','public/mark.svg','site/favicon.svg']:(ROOT/path).write_text(org_svg)
    for size,name in [(32,'favicon-32.png'),(180,'apple-touch-icon.png')]:logo.resize((size,size),Image.Resampling.LANCZOS).save(ROOT/'site'/name,optimize=True)
    logo.save(ROOT/'site/assets/quasynvo-logo.png',optimize=True)
    font_path='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';bold_path='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    font=lambda size,bold=False:ImageFont.truetype(bold_path if bold else font_path,size)
    def render_banner(state,phase,level):
        im=Image.new('RGB',(1200,440),'#080d19');d=ImageDraw.Draw(im)
        # Subtle backglow, hairline frame, and a glass state readout.
        glow=Image.new('RGB',im.size,'#080d19');gd=ImageDraw.Draw(glow)
        gd.ellipse((670,10,1170,460),fill='#15243c');gd.ellipse((950,-170,1400,230),fill='#201733')
        im=Image.blend(im,glow.filter(ImageFilter.GaussianBlur(80)),.65);d=ImageDraw.Draw(im)
        d.rounded_rectangle((1,1,1198,438),radius=18,outline='#26334a')
        d.text((52,38),'Q U A S Y N V O  /  L O C A L - F I R S T  A I',font=font(11),fill='#a8bbce')
        d.text((48,101),'Quasnooze',font=font(66,True),fill='#edf4ff')
        d.text((52,191),'Fluid Motion Voice Engine',font=font(27),fill='#a5eff4')
        d.text((52,238),'Your voice. Your tools. Your permission.',font=font(16),fill='#b4c5db')
        labels={'idle':'01  IDLE','listening':'02  LISTENING','thinking':'03  PROCESSING','speaking':'04  SPEAKING','error':'05  INTERRUPTED'}
        d.rounded_rectangle((52,295,472,341),radius=10,fill='#111d30',outline='#34445e')
        d.ellipse((69,314,77,322),fill=PALETTES[state][0]);d.text((92,310),labels[state],font=font(12,True),fill='#e1edf9')
        d.text((52,389),'SILENT STATE WALKTHROUGH · NOT LIVE AI OR AUDIO',font=font(10),fill='#9aadc6')
        art=engine(440,state,phase,level);im.paste(art,(704,0),art)
        d.text((785,405),'THREE RIBBONS. ONE SIGNAL.',font=font(9),fill='#9aadc6')
        return im
    frames=[render_banner(state,2.4+i*.17,.2+.22*(math.sin(i*.5)+1)) for state in STATES for i in range(15)]
    palette=frames[0].quantize(colors=128)
    animation=[frame.quantize(palette=palette,dither=Image.Dither.NONE) for frame in frames]
    animation[0].save(ROOT/'assets/quasnooze-showcase.gif',save_all=True,append_images=animation[1:],duration=100,loop=0,optimize=True,disposal=1)
    shutil.copyfile(ROOT/'assets/quasnooze-showcase.gif',ROOT/'assets/demo.gif')
    frames[0].save(ROOT/'assets/banner.png',optimize=True)
    # A genuinely static SVG alternative for animation-sensitive readers.
    b64=base64.b64encode((ROOT/'assets/banner.png').read_bytes()).decode()
    (ROOT/'assets/banner.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 440" role="img" aria-label="Quasnooze Fluid Motion Voice Engine — static preview"><image width="1200" height="440" href="data:image/png;base64,{b64}"/></svg>')
    social=Image.new('RGB',(1200,630),'#080d19');social.paste(frames[0],(0,95));ImageDraw.Draw(social).text((52,565),'LOCAL INTELLIGENCE. VISIBLE SIGNAL. YOUR PERMISSION, FIRST.',font=font(13),fill='#b4c5db')
    social.save(ROOT/'site/og-image.png',optimize=True);social.save(ROOT/'docs/brand/quasnooze-social.jpg',quality=91)
    print('Built Fluid Motion SVG, native PNG, static banner and five-state GIF.')
    print('GIF bytes:',(ROOT/'assets/quasnooze-showcase.gif').stat().st_size)

if __name__=='__main__':build()
