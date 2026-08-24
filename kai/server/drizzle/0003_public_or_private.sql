UPDATE `characters`
SET `visibility` = 'public'
WHERE `visibility` IN ('draft', 'unlisted');
