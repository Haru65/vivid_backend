const pool = require('../config/db_connection');


const createActivity = async({
    entityId,
    entityType,
    title,
    activityType,
    activityId,
    description = null,
    actorId = null,
    actorName = null,
    relatedEntityType = null,
    relatedEntityId = null,
    createdAt = new Date().toISOString(),
    metadata = {}
})=> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS activities (  
      entity_type VARCHAR(255) NOT NULL,
      entity_id INTEGER NOT NULL,
      activity_type VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      actor_id INTEGER,
      actor_name VARCHAR(255),
      related_entity_type VARCHAR(255),
      related_entity_id INTEGER,
      meta_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    `);
    const query = `
        INSERT INTO activities (
      entity_type,
      entity_id,
      activity_type,
      title,
      description,
      actor_id,
      actor_name,
      related_entity_type,
      related_entity_id,
      metadata
    
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `;
     const values = [
    entityType,
    entityId,
    activityType,
    title,
    description,
    actorId,
    actorName,
    relatedEntityType,
    relatedEntityId,
    JSON.stringify(metadata)
  ];

    const result = await pool.query(query, values);

    return result.rows[0];
    
    }


module.exports = {
  createActivity
};
