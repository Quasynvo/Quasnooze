# Optional brand asset builder: Python 3 + Pillow. No runtime dependency.
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter
import base64,math,random,shutil
r=Path(__file__).resolve().parents[1]
companion=Image.open(r/'assets/quasnooze-companion-source.png').convert('RGB').resize((770,770),Image.Resampling.LANCZOS)
for rel in ['public/brand/quasnooze-companion.webp','public/brand/cosmic-sloth.webp','site/assets/quasnooze-companion.webp','site/assets/cosmic-sloth.webp']:
 companion.save(r/rel,'WEBP',quality=86,method=6)
companion.resize((160,160),Image.Resampling.LANCZOS).save(r/'public/brand/quasnooze-companion-native.png',optimize=True)
logo=Image.open(r/'assets/quasynvo-logo-source.png').convert('RGB')
mask=logo.point(lambda p:255 if p>120 else 0).convert('L');# Determine mark bounds from cyan pixels, not the dark backdrop.
pix=logo.load();xs=[];ys=[]
for y in range(0,logo.height,4):
 for x in range(0,logo.width,4):
  rr,g,b=pix[x,y]
  if g>160 and b>160:xs.append(x);ys.append(y)
x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys);side=max(x1-x0,y1-y0)*1.35;cx=(x0+x1)/2;cy=(y0+y1)/2
logo=logo.crop((int(cx-side/2),int(cy-side/2),int(cx+side/2),int(cy+side/2))).resize((512,512))
logo.save(r/'assets/quasynvo-logo.png',optimize=True)
b64=base64.b64encode((r/'assets/quasynvo-logo.png').read_bytes()).decode();svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Quasynvo orbital Q logo"><image width="512" height="512" href="data:image/png;base64,{b64}"/></svg>'
for path in ['assets/mark.svg','public/mark.svg','public/favicon.svg','site/favicon.svg','public/brand/cosmic-mark.svg']:(r/path).write_text(svg)
for folder in ['public','site']:
 for size,file in [(32,'favicon-32.png'),(180,'apple-touch-icon.png')]:logo.resize((size,size)).save(r/folder/file,optimize=True)
logo.save(r/'site/assets/quasynvo-logo.png',optimize=True)
shutil.copy(r/'public/brand/quasnooze-companion.webp',r/'site/assets/quasnooze-companion.webp')
F='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
font=lambda n,b=False:ImageFont.truetype(B if b else F,n)
art=Image.open(r/'public/brand/quasnooze-companion.webp').convert('RGB').resize((480,480));random.seed(7);stars=[(random.randrange(1200),random.randrange(440),random.choice([1,1,2])) for _ in range(90)]
def frame(i=0):
 im=Image.new('RGB',(1200,440),'#090d1b');d=ImageDraw.Draw(im)
 for x,y,sz in stars:d.ellipse((x,y,x+sz,y+sz),fill='#46536e')
 # Feather the supplied illustration into the new identity, preserve character.
 artmask=Image.new('L',art.size,0);md=ImageDraw.Draw(artmask);md.ellipse((5,5,475,475),fill=255);artmask=artmask.filter(ImageFilter.GaussianBlur(36))
 im.paste(art,(710,0),artmask)
 im.paste(logo.resize((52,52)),(45,30));d=ImageDraw.Draw(im)
 d.text((110,44),'QUASYNVO',font=font(14,True),fill='#a7d6da');d.text((48,120),'Quasnooze',font=font(68,True),fill='#eff7ff')
 d.text((53,216),'Intelligence, in your orbit.',font=font(25),fill='#9be9e4');d.text((53,260),'Local-first assistance. A cosmic companion.',font=font(16),fill='#a7adc4')
 labels=['HERE, WITH YOU','THINKING · NO ARTIFICIAL DELAY','SPEAKING · SILENT ILLUSTRATION','YOUR PERMISSION, FIRST'];label=labels[(i//6)%4]
 d.rounded_rectangle((52,315,602,363),radius=12,fill='#142333',outline='#325666');d.ellipse((68,333,76,341),fill='#83f5ed');d.text((89,330),label,font=font(12,True),fill='#d2eee9')
 # A restrained orbit tracer and illustrated waveform communicate state, not live telemetry.
 angle=i/24*math.tau;ox=955+212*math.cos(angle);oy=235+212*math.sin(angle)
 d.ellipse((ox-3,oy-3,ox+3,oy+3),fill='#b7fff6')
 for j in range(22):
  height=2 if (i//6)%4==0 else 3+abs(math.sin(j*.7+i*.6))*10
  x=428+j*7;d.line((x,339-height,x,339+height),fill='#83f5ed',width=2)
 d.text((53,396),'ILLUSTRATED STATE WALKTHROUGH · NOT LIVE AI OR AUDIO',font=font(9),fill='#8897b2')
 return im
frames=[frame(i) for i in range(24)];palette=frames[0].quantize(colors=128);animation=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames[::2]];animation[0].save(r/'assets/quasnooze-showcase.gif',save_all=True,append_images=animation[1:],duration=360,loop=0,optimize=True,disposal=1)
shutil.copy(r/'assets/quasnooze-showcase.gif',r/'assets/demo.gif')
frames[0].save(r/'assets/banner.png',optimize=True)
# Retain old asset URLs as compatibility wrappers with the new image, no old claw art.
banner64=base64.b64encode((r/'assets/banner.png').read_bytes()).decode();(r/'assets/banner.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 440" role="img" aria-label="Quasnooze by Quasynvo — Intelligence, in your orbit"><image width="1200" height="440" href="data:image/png;base64,{banner64}"/></svg>')
social=Image.new('RGB',(1200,630),'#090d1b');social.paste(frames[0],(0,95));ImageDraw.Draw(social).text((53,555),'YOUR MACHINE. YOUR PERMISSIONS. YOUR PACE.',font=font(14),fill='#a8b2cf');social.save(r/'site/og-image.png',optimize=True)
# Replace the prior proposed-name banner; original proposal text remains explicitly archived.
social.convert('RGB').save(r/'docs/brand/quasnooze-social.jpg',quality=91)
print('Animation bytes:',(r/'assets/demo.gif').stat().st_size)
