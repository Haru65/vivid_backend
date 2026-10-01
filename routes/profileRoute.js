const express = require('express');
const profileController = require('../controller/profileController');
const authMiddleware = require('../middleware/auth');


const router = express.Router();

router.put('/:userId', authMiddleware.authenticateToken, async (req, res) => {
  await profileController.updateProfile(req, res);
});

module.exports = router;    
