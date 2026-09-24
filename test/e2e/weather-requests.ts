// The fixture gateway owns raw acquisition; browser requests must use prepared feeds.
export const RAW_WEATHER_REQUESTS = /https:\/\/(?:storage\.googleapis\.com|nomads\.ncep\.noaa\.gov)\/|\/weather\/noaa\//;
export const FORECAST_REQUESTS = '**/api/weather/grids/**';
