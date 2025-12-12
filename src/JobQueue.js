import { Job } from './database.js';
import { logger } from './utils.js';

export class JobQueue {
    /**
     * Add a new job to the queue
     * @param {object} jobData 
     * @returns {Promise<string>} jobId
     */
    async add(jobData) {
        try {
            const job = await Job.create({
                type: jobData.type,
                admin_id: jobData.adminId, // Mapped from input
                data: {
                    profileCount: jobData.profileCount
                },
                status: 'queued'
            });
            logger.info(`Job added: ${job._id}`);
            return job._id;
        } catch (error) {
            logger.error("Error adding job to queue:", error);
            throw error;
        }
    }

    /**
     * Get a job by ID
     * @param {string} jobId 
     * @returns {Promise<object>}
     */
    async get(jobId) {
        return await Job.findById(jobId);
    }

    /**
     * Update job status and progress
     * @param {string} jobId 
     * @param {object} updates 
     */
    async update(jobId, updates) {
        const updateData = {};
        if (updates.status) updateData.status = updates.status;
        if (updates.progress) updateData.progress = updates.progress;
        if (updates.completedAt) updateData.completed_at = updates.completedAt; // Map custom field

        await Job.findByIdAndUpdate(jobId, updateData);
    }
}
