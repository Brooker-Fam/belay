-- Belay server schema, version 17: when each phone's help requests began for each caregiver (the
-- seventh security review's H1, docs/design/phase12-caregivers.md). A caregiver sees and is told of
-- only the help requests the kid asked at or after this: from then on the kid's Help screen named
-- them ("Grandma gets your help requests too"). It's the later of the phone being added to their
-- access and help being turned on for them, and it starts again when access is given again. NULL
-- while help is off for them. Number 16 is taken by work done alongside this.

ALTER TABLE caregiver_phones ADD COLUMN help_from INTEGER;  -- ms since the epoch, UTC; NULL while help is off

-- A caregiver from before this: when their phones were added, and when help was turned on, wasn't
-- kept. Their last change is no earlier than either (adding, changing, renewing and ending each set
-- updated_at), so their help begins then: never a request from before, at the cost of some asked
-- between that this caregiver no longer sees (the parents still have every one).
UPDATE caregiver_phones SET help_from = (
  SELECT MAX(c.access_from, c.updated_at) FROM caregivers c WHERE c.id = caregiver_phones.caregiver_id AND c.can_help = 1
);
