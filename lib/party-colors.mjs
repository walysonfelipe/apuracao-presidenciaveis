// Shared display palette for the results page and electoral map.

const PARTY_INFO = {
  PCO: { pos: 0, color: '#7a1f24' },
  PSTU: { pos: 0.1, color: '#8f2328' },
  UP: { pos: 0.2, color: '#a32b30' },
  PCB: { pos: 0.3, color: '#b03236' },
  PSOL: { pos: 1, color: '#f5c542' },
  REDE: { pos: 1.5, color: '#3fbfa8', label: 'Rede' },
  PCDOB: { pos: 2, color: '#9c3a35', label: 'PCdoB' },
  PT: { pos: 3, color: '#e5484d' },
  PV: { pos: 3.5, color: '#5fbf6a' },
  PSB: { pos: 4, color: '#f2a65a' },
  PDT: { pos: 4.5, color: '#d6589a' },
  SOLIDARIEDADE: { pos: 5, color: '#a1887f', label: 'Solidariedade' },
  AVANTE: { pos: 5.2, color: '#c2a27a', label: 'Avante' },
  CIDADANIA: { pos: 5.4, color: '#ec8fb0', label: 'Cidadania' },
  PSDB: { pos: 5.6, color: '#7fa8e0' },
  MDB: { pos: 6, color: '#2f8a4a' },
  PSD: { pos: 6.3, color: '#9ccc65' },
  PODE: { pos: 6.6, color: '#a37be0', label: 'Podemos' },
  AGIR: { pos: 6.9, color: '#78909c', label: 'Agir' },
  MOBILIZA: { pos: 7, color: '#8fa3ad', label: 'Mobiliza' },
  PRD: { pos: 7.1, color: '#5d7480' },
  DC: { pos: 7.2, color: '#6e8592' },
  DEMOCRATA: { pos: 7.2, color: '#6e8592', label: 'Democrata' },
  PMB: { pos: 7.3, color: '#b0bec5' },
  UNIAO: { pos: 7.6, color: '#4fc3f7', label: 'União' },
  PP: { pos: 7.8, color: '#b3e9fb' },
  REPUBLICANOS: { pos: 8.3, color: '#5a86bd', label: 'Republicanos' },
  NOVO: { pos: 9, color: '#ff7a29', label: 'Novo' },
  PL: { pos: 9.5, color: '#4a5ee8' },
  MISSAO: { pos: 9.6, color: '#3443a8', label: 'Missão' },
};
const UNKNOWN_PARTY = { pos: 6.5, color: '#6b7a93' };

export const ElectionParties = Object.freeze({ colors: PARTY_INFO, unknown: UNKNOWN_PARTY });
