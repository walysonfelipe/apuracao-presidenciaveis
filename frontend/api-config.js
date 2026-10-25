// Public settings only. The build can override these through FRONTEND_API_BASE_URL.
window.AppConfig = Object.freeze({
  apiBaseUrl: ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://localhost:3000' : 'https://eleicoes.agendasalao.com',
  dataPrefix: 'resultados',
});
