# Evolv

Mini app móvil para controlar un déficit calórico. Se publica con GitHub Pages y guarda los datos como archivos JSON en este mismo repositorio, sin servidores ni servicios extra.

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html` | Interfaz (Tailwind CSS y Chart.js por CDN) |
| `app.js` | Lógica: API de GitHub, historial diario, picoteo, fórmula de la Marina |
| `data/foods.json` | Catálogo de alimentos con su valor nutricional (editable a mano o desde la app) |
| `data/days.json` | Registro por día, indexado por fecha `YYYY-MM-DD` |
| `data/measurements.json` | Medidas corporales y % de grasa |
| `data/settings.json` | Objetivo diario de kcal y altura |

## Puesta en marcha

1. **Activar GitHub Pages**: Settings → Pages → Source: *Deploy from a branch* → Branch `main`, carpeta `/ (root)`. La app quedará en `https://santymontoyah.github.io/Evolv/`.
2. **Crear un token**: GitHub → Settings → Developer settings → Personal access tokens → *Fine-grained tokens* → Generate new token.
   - Repository access: *Only select repositories* → `Evolv`
   - Permissions → Repository → **Contents: Read and write**
   - Pon una caducidad (por ejemplo 1 año).
3. Abre la app en el móvil, pega el token en Ajustes y fija tu objetivo diario de kcal.

El token se guarda solo en el `localStorage` de ese dispositivo y nunca en el código.

## Formato de `foods.json`

```json
{ "id": "avena-copos", "nombre": "Avena en copos", "porcion_g": 100, "kcal": 372,
  "proteina_g": 13.5, "carbohidratos_g": 58.7, "grasa_g": 7.0, "fibra_g": 10.1, "categoria": "Cereales" }
```

`kcal` y los macros son por `porcion_g` gramos. La app calcula de forma proporcional según los gramos que registres.

## Notas

- Cada guardado es un commit en `main` con el prefijo `data:`.
- El repositorio es público, así que cualquiera puede ver los archivos de `data/`.
- Fórmula de la Marina de EE. UU. (hombre, métrica): `495 / (1.0324 − 0.19077·log10(ombligo − cuello) + 0.15456·log10(177)) − 450`.
