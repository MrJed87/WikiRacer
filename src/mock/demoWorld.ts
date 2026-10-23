/**
 * A seeded, deterministic encyclopedia graph for the offline demo and visual development.
 * Contains 40+ interconnected articles with natural hubs (History, Philosophy, Science, Geography)
 * and dead-ends/loops to showcase all racer behaviours. No DOM.
 */
import { FakeWiki } from './fakeWiki';

export const DEMO_START = 'Château de Montsoreau';
export const DEMO_TARGET = 'Philosophy';

export const DEMO_ARTICLES: Record<string, string[]> = {
  'Château de Montsoreau': [
    'Loire Valley',
    'Renaissance Architecture',
    'Maine-et-Loire',
    'Monuments of France',
  ],
  'Loire Valley': ['France', 'Wine', 'Renaissance Architecture', 'UNESCO World Heritage'],
  'Renaissance Architecture': ['Renaissance', 'Architecture', 'Florence', 'Classical Antiquity'],
  'Maine-et-Loire': ['France', 'Angers', 'Loire Valley'],
  'Monuments of France': ['France', 'Culture of France', 'History of Architecture'],
  Angers: ['Maine-et-Loire', 'Middle Ages', 'University of Angers'],
  'University of Angers': ['Higher Education', 'France', 'Scholasticism'],
  Scholasticism: ['Medieval Philosophy', 'Theology', 'Thomas Aquinas', 'Aristotle'],
  'Medieval Philosophy': ['Philosophy', 'Scholasticism', 'Avicenna', 'Aristotle'],
  France: ['Europe', 'Paris', 'French Revolution', 'Enlightenment'],
  Wine: ['Agriculture', 'Fermentation', 'Ancient Greece', 'Culture of France'],
  'UNESCO World Heritage': ['United Nations', 'Cultural Heritage', 'History of Art'],
  Renaissance: ['Humanism', 'Europe', 'Science', 'Florence', 'Philosophy'],
  Architecture: ['Engineering', 'Art', 'Vitruvius', 'Urban Planning'],
  Florence: ['Italy', 'Renaissance', 'Leonardo da Vinci', 'Medici Family'],
  'Classical Antiquity': ['Ancient Greece', 'Roman Empire', 'History', 'Philosophy'],
  'Culture of France': ['France', 'Literature', 'Cinema', 'French Language'],
  'History of Architecture': ['Architecture', 'Ancient Egypt', 'Classical Antiquity'],
  'Middle Ages': ['Europe', 'Feudalism', 'Crusades', 'Medieval Philosophy'],
  'Higher Education': ['University', 'Academia', 'Science', 'Scholasticism'],
  Theology: ['Religion', 'Philosophy of Religion', 'Scholasticism', 'Faith'],
  'Thomas Aquinas': ['Scholasticism', 'Catholic Church', 'Aristotle', 'Philosophy'],
  Aristotle: ['Ancient Greece', 'Plato', 'Logic', 'Ethics', 'Philosophy'],
  Europe: ['European Union', 'History of Europe', 'Geography', 'Enlightenment'],
  Paris: ['France', 'Sorbonne University', 'French Revolution'],
  'French Revolution': ['France', 'Age of Enlightenment', 'Democracy', 'Human Rights'],
  Enlightenment: ['Age of Enlightenment', 'Science', 'Reason', 'Philosophy'],
  Agriculture: ['Biology', 'Neolithic Revolution', 'Civilization'],
  Fermentation: ['Biochemistry', 'Microbiology', 'Louis Pasteur'],
  'Ancient Greece': ['Classical Antiquity', 'Athens', 'Socrates', 'Democracy', 'Philosophy'],
  'United Nations': ['International Law', 'Human Rights', 'Global Governance'],
  'Cultural Heritage': ['History', 'Archaeology', 'Anthropology'],
  'History of Art': ['Art', 'Visual Arts', 'Aesthetics', 'Philosophy'],
  Humanism: ['Renaissance', 'Secularism', 'Ethics', 'Philosophy'],
  Science: ['Scientific Method', 'Physics', 'Biology', 'Philosophy of Science', 'Philosophy'],
  Leonardo_da_Vinci: ['Renaissance', 'Polymath', 'Art', 'Science'],
  'Medici Family': ['Florence', 'Banking', 'Renaissance Patronage'],
  'Roman Empire': ['Classical Antiquity', 'Rome', 'Law', 'Latin'],
  History: ['Historiography', 'Archaeology', 'Civilization', 'Philosophy of History'],
  University: ['Higher Education', 'Bologna', 'Research', 'Academia'],
  'Age of Enlightenment': ['Enlightenment', 'Voltaire', 'Jean-Jacques Rousseau', 'Philosophy'],
  Socrates: ['Plato', 'Athens', 'Epistemology', 'Philosophy'],
  Plato: ['Socrates', 'Aristotle', 'Academy', 'Metaphysics', 'Philosophy'],
  'Scientific Method': ['Empiricism', 'Francis Bacon', 'Epistemology', 'Science'],
  Philosophy: ['Ethics', 'Epistemology', 'Metaphysics', 'Logic', 'Ancient Greece'],
  Logic: ['Mathematics', 'Philosophy', 'Deductive Reasoning', 'Aristotle'],
  Ethics: ['Moral Philosophy', 'Philosophy', 'Virtue Ethics', 'Utilitarianism'],
};

export const DEMO_SUMMARIES: Record<string, string> = {
  'Château de Montsoreau': 'A Renaissance palace located in the Loire Valley in France.',
  Philosophy:
    'The systematised study of general and fundamental questions concerning existence, reason, knowledge, values, mind, and language.',
  France: 'A transcontinental country predominantly located in Western Europe.',
  Renaissance:
    'A fervent period of European cultural, artistic, political and economic rebirth following the Middle Ages.',
  Aristotle:
    'An Ancient Greek philosopher and polymath whose writings covered many subjects including physics, biology, and philosophy.',
};

export function createDemoWiki(latencyMs = 60): FakeWiki {
  return new FakeWiki(DEMO_ARTICLES, {
    summaries: DEMO_SUMMARIES,
    latencyMs,
  });
}
