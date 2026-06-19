import joi from 'joi';

const userModel = joi.object({
    id: joi.string().required(),
    translation: joi.string().default('BSB'),
    // ISO timestamp of the user's first AI-chat acknowledgment click. Null /
    // absent means they haven't agreed yet — AI chat gates on this. Stored as
    // a timestamp (not a boolean) so a future material Terms change can
    // invalidate all acks earlier than a given date.
    aiTermsAcknowledgedAt: joi.string().isoDate().allow(null, '').default(null),
});

export default userModel;
