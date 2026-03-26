import { Router } from 'express';
import {
  getAllTowns, getTown, createTown, updateTown, deleteTown,
  addAgentToTown, removeAgentFromTown, syncFromPsmux,
} from '../services/hierarchy.js';

const router = Router();

// Sync towns from psmux layout
router.post('/sync', (_req, res) => {
  const towns = syncFromPsmux();
  res.json(towns);
});

// List all towns/cities/etc
router.get('/', (_req, res) => {
  res.json(getAllTowns());
});

// Get single town
router.get('/:id', (req, res) => {
  const town = getTown(req.params.id);
  if (!town) return res.status(404).json({ error: 'Not found' });
  res.json(town);
});

// Create town
router.post('/', (req, res) => {
  const { name, description, color, icon, agents, parent, level } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const town = createTown({
    name,
    description: description || '',
    color: color || '#58a6ff',
    icon: icon || '⬡',
    agents: agents || [],
    parent,
    level: level || 'town',
  });
  res.status(201).json(town);
});

// Update town
router.put('/:id', (req, res) => {
  const town = updateTown(req.params.id, req.body);
  if (!town) return res.status(404).json({ error: 'Not found' });
  res.json(town);
});

// Delete town
router.delete('/:id', (req, res) => {
  const ok = deleteTown(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// Add agent to town
router.post('/:id/agents', (req, res) => {
  const { agentName } = req.body;
  if (!agentName) return res.status(400).json({ error: 'agentName required' });
  const ok = addAgentToTown(req.params.id, agentName);
  if (!ok) return res.status(404).json({ error: 'Town not found' });
  res.json({ success: true });
});

// Remove agent from town
router.delete('/:id/agents/:agentName', (req, res) => {
  const ok = removeAgentFromTown(req.params.id, req.params.agentName);
  if (!ok) return res.status(404).json({ error: 'Town not found' });
  res.json({ success: true });
});

export default router;
