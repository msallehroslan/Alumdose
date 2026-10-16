export interface WeatherPoint {
  hour: string;
  rainfall: number;
  temp: number;
  humidity: number;
  riverLevel: number;
}

export const WEATHER_FORECAST: WeatherPoint[] = Array.from({ length: 24 }, (_, i) => ({
  hour: `${i.toString().padStart(2, "0")}:00`,
  rainfall: Math.max(0, Math.sin(i / 3) * 8 + (i > 13 && i < 19 ? 24 : 0) + Math.random() * 3),
  temp: 24 + Math.sin((i - 6) / 4) * 6,
  humidity: 70 + Math.cos(i / 5) * 12,
  riverLevel: 2.1 + Math.sin(i / 6) * 0.3 + (i > 16 ? 0.4 : 0),
}));
