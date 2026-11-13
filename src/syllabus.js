// Subjects and topics per examination grade, aligned to the Zambian (ECZ) curriculum areas.
// Topics guide AI question generation; edit freely to match the current syllabus.
export const SYLLABUS = {
  7: {
    label: 'Grade 7 (Primary School Leaving Examination)',
    subjects: {
      'English': ['Comprehension', 'Grammar: tenses', 'Parts of speech', 'Punctuation', 'Vocabulary and spelling', 'Sentence construction'],
      'Mathematics': ['Whole numbers', 'Fractions and decimals', 'Percentages', 'Measurement', 'Geometry and shapes', 'Money and ratio', 'Data handling'],
      'Integrated Science': ['Human body and health', 'Plants', 'Animals', 'Matter and materials', 'Energy and electricity', 'Environment and weather'],
      'Social Studies': ['Zambian history', 'Civic education and government', 'Map reading', 'Zambian geography', 'Economic activities', 'Culture and traditions'],
      'Creative and Technology Studies': ['Home economics', 'Expressive arts', 'Technology studies', 'Agriculture basics'],
    },
  },
  9: {
    label: 'Grade 9 (Junior Secondary School Examination)',
    subjects: {
      'English': ['Comprehension', 'Summary writing', 'Grammar and usage', 'Vocabulary', 'Composition skills'],
      'Mathematics': ['Sets', 'Index notation and standard form', 'Algebra and equations', 'Ratio and proportion', 'Geometry and angles', 'Mensuration', 'Statistics', 'Social and commercial arithmetic'],
      'Integrated Science': ['Human biology', 'Plant biology', 'Chemistry of matter', 'Acids, bases and salts', 'Forces and motion', 'Electricity and magnetism', 'Ecology'],
      'Social Studies': ['Zambian and African history', 'Government and the constitution', 'Human rights', 'Physical geography', 'Population and resources', 'Economics basics'],
      'Business Studies': ['Office practice', 'Commerce', 'Bookkeeping basics', 'Entrepreneurship'],
    },
  },
  12: {
    label: 'Grade 12 (School Certificate Examination)',
    subjects: {
      'English': ['Comprehension', 'Summary', 'Structure and usage', 'Vocabulary in context'],
      'Mathematics': ['Sets and functions', 'Quadratic equations', 'Matrices', 'Trigonometry', 'Vectors', 'Probability', 'Statistics', 'Calculus basics', 'Linear programming', 'Earth geometry'],
      'Biology': ['Cell biology', 'Nutrition', 'Transport in plants and animals', 'Respiration', 'Reproduction', 'Genetics', 'Ecology', 'Diseases and immunity'],
      'Chemistry': ['Atomic structure', 'Chemical bonding', 'The mole concept', 'Acids, bases and salts', 'Redox reactions', 'Organic chemistry', 'Rates of reaction', 'Metals and extraction'],
      'Physics': ['Measurement', 'Mechanics', 'Thermal physics', 'Waves and light', 'Electricity', 'Magnetism', 'Atomic physics'],
      'Civic Education': ['The Zambian constitution', 'Governance', 'Human rights', 'Citizenship', 'Development', 'Corruption and accountability'],
      'Geography': ['Map work', 'Physical geography', 'Climate', 'Population', 'Agriculture', 'Mining and industry', 'Zambia regional geography'],
      'History': ['Pre-colonial Central Africa', 'Colonial rule', 'Nationalism and independence', 'Post-independence Zambia', 'World history'],
      'Principles of Accounts': ['Double entry', 'Trial balance', 'Final accounts', 'Bank reconciliation', 'Depreciation', 'Partnership accounts'],
    },
  },
};

export const LANGUAGES = ['English', 'Nyanja', 'Bemba', 'Tonga', 'Lozi'];

export function isValidSubject(grade, subject) {
  return Boolean(SYLLABUS[grade]?.subjects[subject]);
}
export function isValidTopic(grade, subject, topic) {
  return Boolean(SYLLABUS[grade]?.subjects[subject]?.includes(topic));
}
