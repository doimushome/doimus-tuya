const convert = require("color-convert");

class Color {
  static getKelvinFromRGB(red, green, blue) {
    const rgb = [red, green, blue];
    const kelvinMin = 1000;
    const kelvinMax = 10000;
    let guess = 6500;
    let delta = 4500;
    for (let i = 0; i < 10; i++) {
      const tmpRgb = convert.kelvin.rgb(guess);
      const distance = Math.abs(tmpRgb[0] - rgb[0]) + Math.abs(tmpRgb[1] - rgb[1]) + Math.abs(tmpRgb[2] - rgb[2]);
      if (distance < 10) break;
      delta = Math.floor(delta / 2);
      guess += (rgb[0] < tmpRgb[0]) ? -delta : delta;
    }
    return Math.min(kelvinMax, Math.max(kelvinMin, guess));
  }

  static getHSBFromRGB(red, green, blue) {
    const rgb = [red, green, blue];
    const hsv = convert.rgb.hsv(rgb);
    return { hue: hsv[0], saturation: hsv[1], brightness: hsv[2] };
  }

  static getRGBFromHSB(hue, saturation, brightness) {
    const hsv = [hue, saturation, brightness];
    const rgb = convert.hsv.rgb(hsv);
    return { red: rgb[0], green: rgb[1], blue: rgb[2] };
  }
}

module.exports = Color;
