# Container Forest — landing

Landing page and brand assets for [Container Forest](https://github.com/lepterion/container-forest).

- `landing-site/` — the landing page (`index.html` + hero images)
- `landing/` — earlier copy of the landing page
- `brand/` — logo (`logo-a-forest-line.svg`) and concept sketches
- `index.html` — redirects to `landing-site/`
- `scene.html`, `scene.js` — the three.js scene used to render the hero images
- `renders/`, `*-4k.png` — full-resolution renders

## Run locally

```bash
node server.js 5180
```

Then open http://localhost:5180/ (the 3D scene is at /scene.html)
